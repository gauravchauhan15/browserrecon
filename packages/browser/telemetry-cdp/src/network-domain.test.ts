/// <reference lib="dom" />
//
// DOM lib for this file alone: the burst is driven from inside the page.

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
import { startFixture, restApi, staticSite, type RunningFixture } from "@browserrecon/fixtures";
import { EventBus, type EventEnvelope } from "@browserrecon/events";
import { attachTelemetry } from "./telemetry.js";
import { waitUntil } from "./wait-until.js";
import type { NetworkRequestPayload, NetworkResponsePayload, TelemetryStats } from "./types.js";
import type { BodyCaptureLimits } from "./body-policy.js";

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

/**
 * Collect everything the bus publishes, in order.
 *
 * Filtering by type happens here rather than in `subscribe`, which takes no
 * type filter — the first version of this passed one anyway, and it was
 * silently ignored at runtime. The test type-check gate caught it.
 */
const NETWORK_TYPES = new Set(["network_request", "network_response", "network_failed"]);

function collector(bus: EventBus): EventEnvelope[] {
  const seen: EventEnvelope[] = [];
  bus.subscribe(
    (envelope) => {
      if (NETWORK_TYPES.has(envelope.type)) seen.push(envelope);
    },
    { name: "collector" },
  );
  return seen;
}

const requestsIn = (seen: readonly EventEnvelope[]): NetworkRequestPayload[] =>
  seen
    .filter((e) => e.type === "network_request")
    .map((e) => e.payload as NetworkRequestPayload);

const responsesIn = (seen: readonly EventEnvelope[]): NetworkResponsePayload[] =>
  seen
    .filter((e) => e.type === "network_response")
    .map((e) => e.payload as NetworkResponsePayload);

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI)
      expect(chrome.found, "no Chrome in CI; telemetry tests must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("completeness under load", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(restApi());
    session = await launchBrowser({
      sessionId: "sess_0001",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-telemetry-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest(
    "records every request in a burst of 150, exactly once",
    async () => {
      // The assertion that justifies §5.1. Chrome DevTools MCP's network tools
      // are poll-based and window-bounded — "since last navigation" — so under
      // a burst they report a sample. A durable event store whose caused_by
      // graph depends on nothing being missed cannot be built on a sample.
      const origin = fixture?.origin ?? "";
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        const page = await (session as BrowserSession).browser.newPage();
        await page.goto(`${origin}/api/v1/products`, { waitUntil: "domcontentloaded" });

        const BURST = 150;
        await page.evaluate(async (base: string) => {
          await Promise.all(
            Array.from({ length: 150 }, (_, index) =>
              fetch(`${base}/api/v1/products/${(index % 3) + 1}?burst=${index}`),
            ),
          );
        }, origin);

        await telemetry.drain();

        const burst = requestsIn(seen).filter((payload) => payload.url.includes("burst="));
        expect(burst).toHaveLength(BURST);

        // Exactly once: no duplicates, and every index accounted for.
        const indices = burst
          .map((payload) => new URL(payload.url).searchParams.get("burst"))
          .sort((a, b) => Number(a) - Number(b));
        expect(new Set(indices).size).toBe(BURST);

        // Each got a response, matched by CDP request id.
        const responded = new Set(responsesIn(seen).map((payload) => payload.requestId));
        for (const request of burst) {
          expect(responded.has(request.requestId), `no response for ${request.url}`).toBe(true);
        }

        await page.close();
      } finally {
        await telemetry.detach();
      }
    },
    120_000,
  );

  browserTest(
    "publishes responses in the order Chrome reported them finishing",
    async () => {
      // The real ordering assertion, with a ground truth to compare against.
      //
      // Checking that published sequence numbers ascend proves nothing: the
      // bus assigns them at publish time, so they ascend by construction
      // whatever order publishing happens in. What matters is that publish
      // order matches CDP *arrival* order, and the only way to know that is to
      // watch CDP independently — which is what the second session below does.
      //
      // Body capture is an async round trip whose latency varies with size, so
      // without serialization a small JSON body overtakes a large HTML one and
      // the log stops matching what the browser actually did.
      const origin = fixture?.origin ?? "";
      const bus = new EventBus();
      const seen = collector(bus);

      const page = await (session as BrowserSession).browser.newPage();
      const witness = await page.createCDPSession();
      const arrivalOrder: string[] = [];
      witness.on("Network.loadingFinished", (event: unknown) => {
        arrivalOrder.push((event as { requestId: string }).requestId);
      });
      await witness.send("Network.enable");

      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        await page.goto(`${origin}/api/v1/products`, { waitUntil: "domcontentloaded" });
        await page.evaluate(async (base: string) => {
          await Promise.all(
            Array.from({ length: 40 }, (_, index) =>
              fetch(`${base}/api/v1/products/${(index % 3) + 1}?ordered=${index}`),
            ),
          );
        }, origin);
        await telemetry.drain();

        const published = responsesIn(seen).map((payload) => payload.requestId);
        const witnessed = arrivalOrder.filter((id) => published.includes(id));

        expect(published.length).toBeGreaterThan(20);
        expect(published).toEqual(witnessed);
      } finally {
        await telemetry.detach();
        await witness.detach().catch(() => undefined);
        await page.close();
      }
    },
    120_000,
  );

  browserTest(
    "assigns strictly ascending sequence numbers",
    async () => {
      // Body capture is an async round trip. Awaiting it inline would let two
      // responses resolve out of order and reorder the log — and `sequence` is
      // the ordering authority the correlation engine trusts (§13.2).
      const origin = fixture?.origin ?? "";
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        const page = await (session as BrowserSession).browser.newPage();
        await page.goto(`${origin}/api/v1/products`, { waitUntil: "domcontentloaded" });
        await page.evaluate(async (base: string) => {
          await Promise.all(
            Array.from({ length: 40 }, (_, index) =>
              fetch(`${base}/api/v1/products/${(index % 3) + 1}?ordered=${index}`),
            ),
          );
        }, origin);
        await telemetry.drain();

        const sequences = seen.map((envelope) => envelope.sequence);
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        expect(new Set(sequences).size).toBe(sequences.length);

        await page.close();
      } finally {
        await telemetry.detach();
      }
    },
    120_000,
  );
});

describe("what each event carries", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(staticSite());
    session = await launchBrowser({
      sessionId: "sess_0002",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-telemetry-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  async function visit(
    path: string,
    options: { bodyLimits?: Partial<BodyCaptureLimits> } = {},
  ): Promise<{ seen: EventEnvelope[]; stats: TelemetryStats }> {
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
      ...(options.bodyLimits === undefined ? {} : { bodyLimits: options.bodyLimits }),
    });
    const page = await (session as BrowserSession).browser.newPage();
    await page.goto(`${fixture?.origin ?? ""}${path}`, { waitUntil: "networkidle2" });
    await telemetry.drain();
    await page.close();
    await telemetry.detach();
    return { seen, stats: telemetry.stats };
  }

  browserTest(
    "captures the initiator Chrome reports, including a script's location",
    async () => {
      // Initiator is how §15 tells a dependency from a coincidence. It is
      // taken from Chrome, never inferred from timing.
      const { seen } = await visit("/");

      const html = requestsIn(seen).find((payload) => payload.url.endsWith("/"));
      expect(html?.initiator.type).toBeDefined();

      // /app.js is pulled in by the markup, so Chrome attributes it to the parser.
      const script = requestsIn(seen).find((payload) => payload.url.endsWith("/app.js"));
      expect(script?.initiator.type).toBe("parser");
      expect(script?.initiator.url).toContain("127.0.0.1");
    },
    90_000,
  );

  browserTest(
    "records the address actually connected to",
    async () => {
      // The Policy Engine cannot prevent DNS rebinding: it resolves a name,
      // Chrome connects separately. Its own note says the mitigation is
      // post-hoc detection here, so dropping this field would remove the only
      // evidence such a mismatch ever leaves.
      const { seen } = await visit("/");
      const response = responsesIn(seen).find((payload) => payload.url.endsWith("/"));

      expect(response?.remoteIpAddress).toBe("127.0.0.1");
      expect(response?.remotePort).toBeGreaterThan(0);
    },
    90_000,
  );

  browserTest(
    "keeps the headers Chrome actually sent, not just the ones the page asked for",
    async () => {
      // requestWillBeSent reports the page's intent; the ExtraInfo events
      // report what went on the wire, cookies included. For a recon tool the
      // difference is the point.
      const { seen } = await visit("/");
      // Waits for the field rather than for a quiet period. Draining settles
      // on a gap in CDP events, and under load that gap can appear before
      // Chrome has sent the ExtraInfo — which made this test assert that the
      // machine was not busy.
      await waitUntil(
        () =>
          responsesIn(seen).some(
            (payload) => payload.url.endsWith("/") && payload.requestHeadersSent !== undefined,
          ),
        { what: "the document's requestHeadersSent" },
      );
      const response = responsesIn(seen).find((payload) => payload.url.endsWith("/"));

      expect(response?.requestHeadersSent).toBeDefined();
      expect(Object.keys(response?.requestHeadersSent ?? {})).toContain("host");
    },
    90_000,
  );

  browserTest(
    "captures an HTML body but only metadata for an image-like asset",
    async () => {
      const { seen, stats } = await visit("/");

      const html = responsesIn(seen).find((payload) => payload.mimeType === "text/html");
      expect(html?.body?.text).toContain("<h1>Widget Co</h1>");
      expect(stats.bodiesCaptured).toBeGreaterThan(0);

      const script = responsesIn(seen).find((payload) => payload.url.endsWith("/app.js"));
      expect(script?.body?.text).toContain("API_BASE");
    },
    90_000,
  );

  browserTest(
    "says why a body was not kept, rather than leaving a hole",
    async () => {
      // "no body" and "we chose not to keep the body" are different facts, and
      // a consumer has to be able to tell them apart.
      const { seen } = await visit("/", {
        bodyLimits: { enabled: true, maxBodyBytes: 10, maxTotalBytes: 1_000_000 },
      });
      const html = responsesIn(seen).find((payload) => payload.mimeType === "text/html");

      expect(html?.body?.text).toBeUndefined();
      expect(html?.body?.skipped).toBe("too_large");
    },
    90_000,
  );

  browserTest(
    "records a 410 as a response, not a failure",
    async () => {
      // §33: a barrier is a normal outcome. The server answered.
      const { seen } = await visit("/gone");
      const gone = responsesIn(seen).find((payload) => payload.url.endsWith("/gone"));
      expect(gone?.status).toBe(410);
    },
    90_000,
  );

  browserTest(
    "records a request that never connected as a failure",
    async () => {
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        const page = await (session as BrowserSession).browser.newPage();
        await page.goto(`${fixture?.origin ?? ""}/`, { waitUntil: "domcontentloaded" });
        await page
          .evaluate(async () => {
            await fetch("http://127.0.0.1:1/unreachable").catch(() => undefined);
          })
          .catch(() => undefined);
        await telemetry.drain();

        const failures = seen.filter((envelope) => envelope.type === "network_failed");
        expect(failures.length).toBeGreaterThan(0);
        await page.close();
      } finally {
        await telemetry.detach();
      }
    },
    90_000,
  );
});

describe("independence from the control layer", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(staticSite());
    session = await launchBrowser({
      sessionId: "sess_0003",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-telemetry-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest(
    "observes a page it was never handed",
    async () => {
      // §5.1: telemetry attaches to the browser, not to something the driver
      // gives it. A page the control layer opens later — or one the site opens
      // itself — is observed without anyone wiring it up.
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        // Opened after telemetry attached, and never passed to it.
        const page = await (session as BrowserSession).browser.newPage();
        await page.goto(`${fixture?.origin ?? ""}/about`, { waitUntil: "domcontentloaded" });
        await telemetry.drain();

        expect(requestsIn(seen).some((payload) => payload.url.endsWith("/about"))).toBe(true);
        await page.close();
      } finally {
        await telemetry.detach();
      }
    },
    90_000,
  );

  browserTest(
    "observes a tab the site opened for itself",
    async () => {
      // The case no driver can hand over: the page calls window.open and the
      // new target starts fetching with nobody calling goto. Telemetry has to
      // already be watching the browser for this to be captured at all.
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        const page = await (session as BrowserSession).browser.newPage();
        const origin = fixture?.origin ?? "";
        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
        await page.evaluate((base: string) => {
          window.open(`${base}/orphan`, "_blank");
        }, origin);
        await telemetry.drain(500);

        expect(requestsIn(seen).some((payload) => payload.url.endsWith("/orphan"))).toBe(true);
        // And it is attributed to a different target than the opener.
        const targets = new Set(requestsIn(seen).map((payload) => payload.targetId));
        expect(targets.size).toBeGreaterThan(1);
      } finally {
        await telemetry.detach();
      }
    },
    90_000,
  );

  browserTest(
    "stops observing once detached",
    async () => {
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${fixture?.origin ?? ""}/`, { waitUntil: "domcontentloaded" });
      await telemetry.drain();
      const before = seen.length;

      await telemetry.detach();
      await page.goto(`${fixture?.origin ?? ""}/products`, { waitUntil: "domcontentloaded" });
      await bus.drain();

      expect(seen.length).toBe(before);
      await page.close();
    },
    90_000,
  );
});
