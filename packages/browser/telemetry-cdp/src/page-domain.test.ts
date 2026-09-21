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
import { framedSite, startFixture, type RunningFixture } from "@browserrecon/fixtures";
import { EventBus, type EventEnvelope } from "@browserrecon/events";
import { attachTelemetry } from "./telemetry.js";
import { waitUntil } from "./wait-until.js";
import type {
  ExecutionContextPayload,
  NavigationCommittedPayload,
  NavigationStartedPayload,
  PageLoadedPayload,
  ScriptParsedPayload,
} from "./page-types.js";
import type { NetworkRequestPayload } from "./types.js";

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

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) expect(chrome.found, "no Chrome in CI; these tests must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("navigation", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(framedSite());
    session = await launchBrowser({
      sessionId: "sess_0001",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-page-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest("reports a hard navigation as an ordered started/committed pair", async () => {
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${origin}/second`, { waitUntil: "load" });
      await telemetry.drain();
      // Same reason as in network-domain.test.ts: wait for the pair to
      // exist rather than for the browser to go quiet.
      await waitUntil(
        () =>
          payloadsOf<NavigationStartedPayload>(seen, "navigation_started").some(
            (payload) => payload.isMainFrame,
          ) &&
          payloadsOf<NavigationCommittedPayload>(seen, "navigation_committed").some((payload) =>
            payload.url.endsWith("/second"),
          ),
        { what: "the navigation started/committed pair" },
      );

      const started = payloadsOf<NavigationStartedPayload>(seen, "navigation_started").filter(
        (payload) => payload.isMainFrame,
      );
      const committed = payloadsOf<NavigationCommittedPayload>(
        seen,
        "navigation_committed",
      ).filter((payload) => payload.url.endsWith("/second"));

      expect(started.length).toBeGreaterThan(0);
      expect(committed.length).toBe(1);

      // The pair is joinable, which is what BR-M1-07 and §18's workflow
      // boundaries need: CDP has no id that spans start to commit, so one is
      // allocated here and carried through.
      const navigationId = committed[0]?.navigationId;
      expect(started.some((payload) => payload.navigationId === navigationId)).toBe(true);

      // And ordered: the start is published before the commit.
      const order = seen
        .filter((envelope) =>
          ["navigation_started", "navigation_committed"].includes(envelope.type),
        )
        .filter(
          (envelope) =>
            (envelope.payload as NavigationStartedPayload).navigationId === navigationId,
        )
        .map((envelope) => envelope.type);
      expect(order[0]).toBe("navigation_started");
      expect(order.at(-1)).toBe("navigation_committed");

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });

  browserTest(
    "carries the navigation id on the envelope, not only in the payload",
    async () => {
      // So a consumer can group a navigation's events without parsing payloads.
      const origin = fixture?.origin ?? "";
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        const page = await (session as BrowserSession).browser.newPage();
        await page.goto(`${origin}/second`, { waitUntil: "load" });
        await telemetry.drain();

        const committed = seen.find(
          (envelope) =>
            envelope.type === "navigation_committed" &&
            (envelope.payload as NavigationCommittedPayload).url.endsWith("/second"),
        );
        expect(committed?.navigation_id).toBeDefined();
        expect(committed?.navigation_id).toBe(
          (committed?.payload as NavigationCommittedPayload).navigationId,
        );

        await page.close();
      } finally {
        await telemetry.detach();
      }
    },
  );

  browserTest("reports load and DOMContentLoaded for the main frame", async () => {
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${origin}/second`, { waitUntil: "load" });
      await telemetry.drain();

      const loads = payloadsOf<PageLoadedPayload>(seen, "page_loaded");
      expect(loads.some((payload) => payload.event === "domcontentloaded")).toBe(true);
      expect(loads.some((payload) => payload.event === "load")).toBe(true);

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });
});

describe("frames", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(framedSite());
    session = await launchBrowser({
      sessionId: "sess_0002",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-page-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest(
    "attributes a child frame's navigation to that frame, not the top document",
    async () => {
      // The error this prevents is not cosmetic. A scan that merges an iframe's
      // activity into the top document reports a third-party widget's endpoints
      // as the target's own attack surface.
      const origin = fixture?.origin ?? "";
      const bus = new EventBus();
      const seen = collector(bus);
      const telemetry = await attachTelemetry({
        browser: (session as BrowserSession).browser,
        bus,
      });

      try {
        const page = await (session as BrowserSession).browser.newPage();
        await page.goto(`${origin}/frames`, { waitUntil: "load" });
        await telemetry.drain(500);

        const committed = payloadsOf<NavigationCommittedPayload>(seen, "navigation_committed");

        const top = committed.find((payload) => payload.url.endsWith("/frames"));
        const panel = committed.find((payload) => payload.url.endsWith("/frames/panel"));
        const leaf = committed.find((payload) => payload.url.endsWith("/frames/leaf"));

        expect(top?.isMainFrame).toBe(true);
        expect(panel?.isMainFrame).toBe(false);
        expect(leaf?.isMainFrame).toBe(false);

        // Distinct frames, and the grandchild's parent is the middle frame
        // rather than the top document.
        expect(panel?.frameId).not.toBe(top?.frameId);
        expect(leaf?.frameId).not.toBe(top?.frameId);
        expect(leaf?.parentFrameId).not.toBe(top?.frameId);

        const deep = committed.find((payload) => payload.url.endsWith("/frames/deep"));
        expect(leaf?.parentFrameId).toBe(deep?.frameId);

        await page.close();
      } finally {
        await telemetry.detach();
      }
    },
  );

  browserTest("attributes a request to the frame that issued it", async () => {
    // /api/panel is fetched only from inside the panel frame, and /api/leaf
    // only from the grandchild. If both were attributed to the top document
    // the surface model would be wrong in a way nothing downstream can undo.
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${origin}/frames`, { waitUntil: "load" });
      await telemetry.drain(500);

      const requests = payloadsOf<NetworkRequestPayload>(seen, "network_request");
      const committed = payloadsOf<NavigationCommittedPayload>(seen, "navigation_committed");

      const panelFrame = committed.find((payload) => payload.url.endsWith("/frames/panel"));
      const leafFrame = committed.find((payload) => payload.url.endsWith("/frames/leaf"));
      const panelCall = requests.find((payload) => payload.url.endsWith("/api/panel"));
      const leafCall = requests.find((payload) => payload.url.endsWith("/api/leaf"));

      expect(panelCall?.frameId).toBe(panelFrame?.frameId);
      expect(leafCall?.frameId).toBe(leafFrame?.frameId);
      expect(panelCall?.frameId).not.toBe(leafCall?.frameId);

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });

  browserTest("sees a frame added by script after load", async () => {
    // The case a one-shot DOM read misses entirely.
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${origin}/frames`, { waitUntil: "load" });
      await telemetry.drain(700);

      const committed = payloadsOf<NavigationCommittedPayload>(seen, "navigation_committed");
      expect(committed.some((payload) => payload.url.endsWith("/frames/late"))).toBe(true);

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });
});

describe("execution contexts and scripts", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(framedSite());
    session = await launchBrowser({
      sessionId: "sess_0003",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-page-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest("does not leak stale context ids across a navigation", async () => {
    // Chrome reuses context ids. A stale id left in the map would attribute
    // the new page's scripts to the old page's context — and the error is
    // invisible, because everything still has *an* id. The count is the
    // signal: it must not grow without bound across navigations.
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();

      await page.goto(`${origin}/second`, { waitUntil: "load" });
      await telemetry.drain();
      const afterFirst = telemetry.stats.liveExecutionContexts;

      for (let visit = 0; visit < 3; visit += 1) {
        await page.goto(`${origin}/frames/leaf`, { waitUntil: "load" });
        await page.goto(`${origin}/second`, { waitUntil: "load" });
      }
      await telemetry.drain();

      // Six more navigations must not mean six more live contexts.
      expect(telemetry.stats.liveExecutionContexts).toBeLessThanOrEqual(afterFirst + 1);

      // And destruction is observable, not merely internal bookkeeping.
      const contexts = payloadsOf<ExecutionContextPayload>(seen, "js_execution_context");
      expect(contexts.some((payload) => payload.event === "created")).toBe(true);
      expect(
        contexts.some(
          (payload) => payload.event === "destroyed" || payload.event === "cleared",
        ),
      ).toBe(true);

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });

  browserTest("inventories an inline script the network never saw", async () => {
    // The whole reason Debugger.scriptParsed is worth enabling: the network
    // sees files, this sees scripts. §10A has nothing to mine for an inline
    // block, an eval, or anything a bundler injected at runtime.
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${origin}/second`, { waitUntil: "load" });
      await page.evaluate(() => {
        // Created at runtime, with no URL and no network request.
        new Function("return 1 + 1")();
      });
      await telemetry.drain();

      const scripts = payloadsOf<ScriptParsedPayload>(seen, "script_parsed");
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.some((payload) => payload.inline)).toBe(true);

      // No two events for one script id.
      const ids = scripts.map((payload) => payload.scriptId);
      expect(new Set(ids).size).toBe(ids.length);

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });

  browserTest("can be told not to enable the Debugger domain", async () => {
    // Script inventory instruments V8. A scan that only wants network data
    // should not pay for it.
    const origin = fixture?.origin ?? "";
    const bus = new EventBus();
    const seen = collector(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
      inventoryScripts: false,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${origin}/second`, { waitUntil: "load" });
      await telemetry.drain();

      expect(payloadsOf(seen, "script_parsed")).toHaveLength(0);
      // And the rest still works.
      expect(payloadsOf(seen, "navigation_committed").length).toBeGreaterThan(0);

      await page.close();
    } finally {
      await telemetry.detach();
    }
  });
});
