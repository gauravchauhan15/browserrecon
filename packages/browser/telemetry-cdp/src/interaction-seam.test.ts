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
import { PuppeteerBrowserAdapter } from "@browserrecon/browser-adapter";
import { recordInteractions } from "@browserrecon/collector-interaction";
import { spaSite, startFixture, type RunningFixture } from "@browserrecon/fixtures";
import { PolicyEngine, defaultTargetPolicy, type TargetPolicy } from "@browserrecon/policy";
import { EventBus, type EventEnvelope } from "@browserrecon/events";
import { attachTelemetry } from "./telemetry.js";

/**
 * Click → interaction → request, end to end.
 *
 * The criterion this story exists for is that a request can be attributed to
 * the interaction that caused it, and that is only demonstrable against a
 * real page: the interaction has to land in the event sequence *before* the
 * requests the click set off, and nothing but a browser produces that
 * ordering.
 *
 * Lives here rather than in the collector because holding a browser handle is
 * confined to `packages/browser/**` (§32.10).
 */

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

function policyFor(origin: string): TargetPolicy {
  const resolved = defaultTargetPolicy(origin);
  if (!resolved.ok) throw new Error(`invalid test policy for ${origin}`);
  // Fixtures listen on loopback, which the default policy refuses — the same
  // opt-in a user scanning their own dev server makes.
  return { ...resolved.policy, network: { ...resolved.policy.network, denyLoopback: false } };
}

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) expect(chrome.found, "no Chrome in CI; these tests must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("attributing a request to the click that caused it", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(spaSite());
    session = await launchBrowser({
      sessionId: "sess_0001",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-int-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  /** Everything the bus saw, with the recording adapter driving. */
  async function run(
    body: (adapter: ReturnType<typeof recordInteractions>) => Promise<void>,
  ): Promise<EventEnvelope[]> {
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen: EventEnvelope[] = [];
    bus.subscribe((envelope) => void seen.push(envelope), { name: "collector" });

    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });
    const inner = await PuppeteerBrowserAdapter.create({
      session: session as BrowserSession,
      engine: new PolicyEngine(policyFor(origin)),
    });
    const adapter = recordInteractions({ adapter: inner, bus });

    try {
      await body(adapter);
      await telemetry.drain(500);
    } finally {
      await adapter.close();
      await telemetry.detach();
    }
    return seen;
  }

  browserTest("puts the interaction before the requests the click set off", async () => {
    // The ordering is the attribution. §15 correlates from the sequence, and
    // an interaction recorded after its own consequences is useless.
    const origin = fixture?.origin ?? "";
    const seen = await run(async (adapter) => {
      await adapter.navigate(`${origin}/`);
      await adapter.click("#to-orders");
      await adapter.waitForSettled({ timeoutMs: 1_500 });
    });

    const click = seen.find(
      (envelope) =>
        envelope.type === "interaction" &&
        (envelope.payload as { kind: string }).kind === "click",
    );
    const apiCall = seen.find(
      (envelope) =>
        envelope.type === "network_request" &&
        (envelope.payload as { url: string }).url.endsWith("/api/orders"),
    );

    expect(click, "no click interaction recorded").toBeDefined();
    expect(apiCall, "the click did not produce the API call").toBeDefined();
    expect(click?.sequence).toBeLessThan(apiCall?.sequence ?? 0);
  });

  browserTest("gives the request an interaction id to be attributed to", async () => {
    const origin = fixture?.origin ?? "";
    let idAtClick: string | undefined;

    const seen = await run(async (adapter) => {
      await adapter.navigate(`${origin}/`);
      await adapter.click("#to-orders");
      idAtClick = adapter.currentInteractionId;
      await adapter.waitForSettled({ timeoutMs: 1_500 });
    });

    expect(idAtClick).toBeDefined();
    const click = seen.find(
      (envelope) =>
        envelope.type === "interaction" &&
        (envelope.payload as { interactionId: string }).interactionId === idAtClick,
    );
    expect(click).toBeDefined();
  });

  browserTest("records a reference that finds the same element again", async () => {
    // "Reproducible" has to mean more than "the same string twice": the
    // selector has to actually re-find the element on a fresh page.
    const origin = fixture?.origin ?? "";
    let selector: string | undefined;

    await run(async (adapter) => {
      await adapter.navigate(`${origin}/`);
      const result = await adapter.click("#to-orders");
      expect(result.status).toBe("ok");
      selector = adapter.model.latest?.element?.selector;
    });

    expect(selector).toBe("#to-orders");

    // A second, independent run finds it by the recorded selector alone.
    const second = await run(async (adapter) => {
      await adapter.navigate(`${origin}/`);
      const result = await adapter.click(selector ?? "");
      expect(result.status).toBe("ok");
    });
    expect(second.length).toBeGreaterThan(0);
  });

  browserTest("produces the same reference on two separate runs", async () => {
    const origin = fixture?.origin ?? "";
    const referenceFrom = async (): Promise<unknown> => {
      let captured: unknown;
      await run(async (adapter) => {
        await adapter.navigate(`${origin}/`);
        await adapter.click("#filter");
        captured = adapter.model.latest?.element;
      });
      return captured;
    };

    const first = await referenceFrom();
    // Asserted defined before comparing. The first version of this compared
    // two undefined values and passed while recording nothing at all.
    expect(first).toBeDefined();
    expect(await referenceFrom()).toEqual(first);
  });

  browserTest("records a refused click as an interaction, not a silence", async () => {
    // §8.6: a policy refusal is a barrier worth recording. A scan that simply
    // shows nothing where a click was attempted cannot explain its coverage.
    const origin = fixture?.origin ?? "";
    const seen = await run(async (adapter) => {
      await adapter.navigate(`${origin}/`);
      // The default policy forbids state-changing actions, and a bare
      // <button> in a form is a submit.
      await adapter.click("#filter", { stateChanging: true });
    });

    const refused = seen.find(
      (envelope) =>
        envelope.type === "interaction" &&
        (envelope.payload as { outcome: string }).outcome === "denied",
    );
    expect(refused).toBeDefined();
    expect((refused?.payload as { denialReason?: string }).denialReason).toBe(
      "action_state_changing_denied",
    );
  });
});
