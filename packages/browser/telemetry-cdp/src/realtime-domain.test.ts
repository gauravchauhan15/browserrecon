import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  launchBrowser,
  resolveChromePath,
  type BrowserSession,
  type ChromeProbes,
} from "@browserrecon/browser-manager";
import {
  WS_CLIENT_MESSAGES,
  WS_GREETING,
  realtimeSite,
  startFixture,
  type RunningFixture,
} from "@browserrecon/fixtures";
import { EventBus, type EventEnvelope } from "@browserrecon/events";
import { attachTelemetry } from "./telemetry.js";
import type {
  EventSourceMessagePayload,
  WebSocketClosedPayload,
  WebSocketCreatedPayload,
  WebSocketFramePayload,
  WebSocketOpenedPayload,
} from "./realtime-types.js";

const probes: ChromeProbes = {
  fileExists: (path) => existsSync(path),
  runCommand: (command, args) => {
    const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 5_000 });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  },
  platform: platform(),
  env: {},
};

const chrome = resolveChromePath(probes);
const CI = process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false";
const browserTest = chrome.found ? it : it.skip;

function collector(bus: EventBus): EventEnvelope[] {
  const seen: EventEnvelope[] = [];
  bus.subscribe((envelope) => void seen.push(envelope), { name: "collector" });
  return seen;
}

const payloadsOf = <T>(seen: readonly EventEnvelope[], type: string): T[] =>
  seen.filter((envelope) => envelope.type === type).map((envelope) => envelope.payload as T);

/**
 * Drain until the exchange has finished, rather than for a fixed window.
 *
 * These tests used to wait `drain(600)` and then assert. That is a bet that a
 * real browser completes a WebSocket or SSE exchange within 600 ms, which
 * holds on an idle machine and does not when the rest of the suite is running
 * several headless Chromes beside it — the assertion then fails with "the
 * greeting frame was not recorded at all", which reads like a collector bug
 * and is not one.
 *
 * Found on a fresh clone: this test failed in the full run and passed in
 * isolation, on the same commit. Waiting for the condition instead is both
 * faster when the machine is idle and reliable when it is not; the ceiling is
 * generous because it is only reached when something is genuinely wrong.
 */
async function settleUntil(
  telemetry: { drain: (quietMs?: number) => Promise<void> },
  done: () => boolean,
  ceilingMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  do {
    await telemetry.drain(150);
  } while (!done() && Date.now() < deadline);
  // One further pass, so an event published during the last check is included.
  await telemetry.drain(150);
}

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) expect(chrome.found, "no Chrome in CI; these tests must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("WebSocket", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(realtimeSite());
    session = await launchBrowser({
      sessionId: "sess_0001",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-realtime-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  /** Drive the fixture page and return everything the bus saw. */
  async function exchange(
    options: {
      bodyLimits?: { enabled: boolean; maxBodyBytes: number; maxTotalBytes: number };
    } = {},
  ): Promise<EventEnvelope[]> {
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
      ...(options.bodyLimits === undefined ? {} : { bodyLimits: options.bodyLimits }),
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${fixture?.origin ?? ""}/`, { waitUntil: "load" });
      // The fixture closes the socket when it is done, so the close event is
      // the exchange's own terminal signal — nothing else has to be guessed.
      await settleUntil(telemetry, () =>
        seen.some((envelope) => envelope.type === "websocket_closed"),
      );
      await page.close();
    } finally {
      await telemetry.detach();
    }
    return seen;
  }

  browserTest("captures the handshake, both directions of frames, and the close", async () => {
    // §5.1 names WebSocket frames as a capability the MCP tool surface does
    // not expose. This is the assertion behind that claim rather than a
    // restatement of it.
    const seen = await exchange();

    const created = payloadsOf<WebSocketCreatedPayload>(seen, "websocket_created");
    const opened = payloadsOf<WebSocketOpenedPayload>(seen, "websocket_opened");
    const frames = payloadsOf<WebSocketFramePayload>(seen, "websocket_frame");
    const closed = payloadsOf<WebSocketClosedPayload>(seen, "websocket_closed");

    expect(created).toHaveLength(1);
    expect(created[0]?.url).toContain("/ws");
    expect(opened[0]?.status).toBe(101);
    expect(closed.length).toBeGreaterThan(0);

    expect(frames.some((frame) => frame.direction === "sent")).toBe(true);
    expect(frames.some((frame) => frame.direction === "received")).toBe(true);

    // Every frame joins back to its socket by request id.
    const socketId = created[0]?.requestId;
    expect(frames.every((frame) => frame.requestId === socketId)).toBe(true);
  });

  browserTest("records the frames in the order the exchange happened", async () => {
    // The fixture is driven by what arrives rather than by a timer, so the
    // conversation is the same on every run and order is assertable.
    const seen = await exchange();
    const frames = payloadsOf<WebSocketFramePayload>(seen, "websocket_frame").filter(
      (frame) => frame.opcodeName === "text",
    );

    const texts = frames.map((frame) => `${frame.direction}:${frame.payload ?? ""}`);

    // The page sends on `open`, which wins the race against the server's
    // greeting — asserted as measured rather than as assumed.
    expect(texts[0]).toBe(`sent:${WS_CLIENT_MESSAGES[0]}`);
    expect(texts[1]).toBe(`received:${WS_GREETING}`);
    expect(texts[2]).toBe(`sent:${WS_CLIENT_MESSAGES[1]}`);
    expect(texts[3]).toBe(`received:echo:${WS_CLIENT_MESSAGES[0]}`);

    // The whole exchange is present, not a sample of it.
    for (const message of WS_CLIENT_MESSAGES) {
      expect(texts, `client message "${message}" missing`).toContain(`sent:${message}`);
    }
  });

  browserTest("records the opcode, so a keepalive stays separable from traffic", async () => {
    // §17A wants `keepalive` separable from application traffic, and §32.1
    // says this layer observes rather than interprets. So what is recorded is
    // the RFC 6455 opcode — a protocol fact — and the classification built on
    // it belongs to BR-M1-22.
    const seen = await exchange();
    const frames = payloadsOf<WebSocketFramePayload>(seen, "websocket_frame");

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.opcodeName, `opcode ${frame.opcode} unnamed`).not.toMatch(/^unknown_/);
      expect(frame.controlFrame).toBe(frame.opcode >= 0x8);
    }

    // The application-level keepalive — a text frame whose content says it is
    // a heartbeat — is captured with its payload intact, which is what
    // BR-M1-22 needs in order to classify it.
    const heartbeat = frames.find((frame) => frame.payload === '{"type":"ping"}');
    expect(heartbeat, "the application keepalive was not captured").toBeDefined();
    expect(heartbeat?.opcodeName).toBe("text");
    expect(heartbeat?.controlFrame).toBe(false);
  });

  browserTest("pins a CDP limitation: protocol ping and pong are never reported", async () => {
    // Measured, not assumed. The fixture sends a real opcode-0x9 ping and
    // Chrome reports nothing — the DevTools Network domain does not surface
    // WebSocket control frames, so NO tool built on CDP can observe them,
    // this one or chrome-devtools-mcp alike.
    //
    // That matters because §17A names "WebSocket pings" as its first example
    // of `keepalive`, and that specific case is unreachable. Application-level
    // heartbeats, which is what most real applications actually send, are
    // captured normally.
    //
    // This test exists to fail if the limitation ever lifts.
    const seen = await exchange();
    const frames = payloadsOf<WebSocketFramePayload>(seen, "websocket_frame");

    expect(frames.some((frame) => frame.opcodeName === "ping")).toBe(false);
    expect(frames.some((frame) => frame.opcodeName === "pong")).toBe(false);
    expect(frames.every((frame) => frame.controlFrame === false)).toBe(true);
  });

  browserTest("respects the payload cap, and still records the frame", async () => {
    // A skipped payload is not a skipped event. The shape of a conversation —
    // how many frames, which way, how big, in what order — is most of what
    // makes it a workflow, and it survives even when the contents do not.
    const seen = await exchange({
      bodyLimits: { enabled: true, maxBodyBytes: 4, maxTotalBytes: 1_000_000 },
    });
    const frames = payloadsOf<WebSocketFramePayload>(seen, "websocket_frame");

    const greeting = frames.find((frame) => frame.payloadBytes === WS_GREETING.length);
    expect(greeting, "the greeting frame was not recorded at all").toBeDefined();
    expect(greeting?.payload).toBeUndefined();
    expect(greeting?.skipped).toBe("too_large");
    // The size is still known, which is what makes the omission auditable.
    expect(greeting?.payloadBytes).toBeGreaterThan(4);
  });

  browserTest("can have payload capture switched off entirely", async () => {
    const seen = await exchange({
      bodyLimits: { enabled: false, maxBodyBytes: 1_000, maxTotalBytes: 1_000 },
    });
    const frames = payloadsOf<WebSocketFramePayload>(seen, "websocket_frame");

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.payload === undefined)).toBe(true);
    expect(frames.every((frame) => frame.skipped === "disabled")).toBe(true);
  });
});

describe("EventSource", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(realtimeSite());
    session = await launchBrowser({
      sessionId: "sess_0002",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-realtime-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest("captures every server-sent event, named and unnamed", async () => {
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${fixture?.origin ?? ""}/`, { waitUntil: "load" });
      await settleUntil(telemetry, () => payloadsOf(seen, "eventsource_message").length >= 4);

      const messages = payloadsOf<EventSourceMessagePayload>(seen, "eventsource_message");
      expect(messages.length).toBeGreaterThanOrEqual(4);

      // An unnamed event is `message` by the SSE spec. Recording the default
      // explicitly means a consumer never has to know that rule.
      const unnamed = messages.filter((message) => message.eventName === "message");
      expect(unnamed.map((message) => message.data)).toEqual(["first", "second"]);

      const ticks = messages.filter((message) => message.eventName === "tick");
      expect(ticks.map((message) => message.data)).toEqual(["1", "2"]);
      // The stream's `id:` is what a client replays from after a reconnect.
      expect(ticks.at(-1)?.eventId).toBe("42");

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });

  browserTest("does not report a comment line as an event", async () => {
    // `: keepalive` is SSE's keepalive (§17A). It is not a message, and
    // reporting it as one would invent application traffic that never existed.
    // The connection carrying it is still in the network log as a
    // text/event-stream response, so the keepalive is not lost — it is simply
    // not misfiled.
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${fixture?.origin ?? ""}/`, { waitUntil: "load" });
      await settleUntil(telemetry, () => payloadsOf(seen, "eventsource_message").length >= 4);

      const messages = payloadsOf<EventSourceMessagePayload>(seen, "eventsource_message");
      expect(messages.some((message) => message.data?.includes("keepalive") === true)).toBe(
        false,
      );
      expect(messages).toHaveLength(4);

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });
});
