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
import { spaSite, startFixture, type RunningFixture } from "@browserrecon/fixtures";
import { collectNavigation, type NavigationModel } from "@browserrecon/collector-navigation";
import { EventBus } from "@browserrecon/events";
import { attachTelemetry } from "./telemetry.js";

/**
 * Soft navigation, end to end: a real SPA, a real browser, CDP, the bus, and
 * the navigation collector.
 *
 * Every acceptance criterion for BR-M1-07 is about what a browser actually
 * does, and none of it can be proven against hand-published events — the
 * collector's own tests do that, and they would pass just as happily against
 * a payload shape Chrome never produces.
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

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) expect(chrome.found, "no Chrome in CI; these tests must not be skipped").toBe(true);
    expect(true).toBe(true);
  });
});

describe("a single-page application", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(spaSite());
    session = await launchBrowser({
      sessionId: "sess_0001",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-nav-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  /** Load the SPA, run a script against it, and return the model. */
  async function drive(
    body: (page: Awaited<ReturnType<BrowserSession["browser"]["newPage"]>>) => Promise<void>,
  ): Promise<NavigationModel> {
    const bus = new EventBus();
    const collector = collectNavigation(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${fixture?.origin ?? ""}/`, { waitUntil: "load" });
      await body(page);
      await telemetry.drain(500);
      await page.close();
      return collector.model;
    } finally {
      await telemetry.detach();
      collector.stop();
    }
  }

  browserTest(
    "produces a soft navigation for a route change with no document load",
    async () => {
      // The criterion the whole story exists for. A request-oriented scan sees
      // one document load and concludes the application has one page.
      const model = await drive(async (page) => {
        await page.click("#to-orders");
      });

      const soft = model.navigations.filter((navigation) => navigation.kind === "soft");
      expect(soft.length).toBeGreaterThan(0);
      expect(soft.some((navigation) => navigation.to.endsWith("/app/orders"))).toBe(true);

      // And exactly one document load — the initial one.
      expect(model.hard).toBe(1);
    },
  );

  browserTest("tells push, replace, hash and traverse apart", async () => {
    // Chrome's own navigationType cannot do this: pushState and replaceState
    // are both `historyApi`, and a traversal is reported as `fragment` even
    // when the path changes. The Navigation API's history position can.
    const model = await drive(async (page) => {
      await page.click("#to-orders");
      await page.click("#filter");
      await page.click("#to-anchor");
      await page.goBack();
      await page.goForward();
    });

    const soft = model.navigations.filter((navigation) => navigation.kind === "soft");
    const subtypes = soft.map((navigation) => navigation.subtype);

    expect(subtypes).toContain("push");
    expect(subtypes).toContain("replace");
    expect(subtypes).toContain("hash");
    expect(subtypes).toContain("traverse");

    // Every one of them decided from the strong evidence, not the label.
    expect(soft.every((navigation) => navigation.subtypeBasis === "navigation_api")).toBe(true);
  });

  browserTest("records the transition, not just the destination", async () => {
    const model = await drive(async (page) => {
      await page.click("#to-orders");
    });

    const orders = model.navigations.find((navigation) =>
      navigation.to.endsWith("/app/orders"),
    );
    expect(orders?.from).toBe(`${fixture?.origin ?? ""}/`);
    expect(orders?.kind).toBe("soft");
    expect(orders?.isMainFrame).toBe(true);
  });

  browserTest("links a route change to the click that caused it", async () => {
    // The interaction collector is BR-M1-08, so this publishes the
    // interaction the way that collector will — which is also the point: the
    // navigation collector consumes a bus, not a browser, so the two can be
    // built in either order.
    const bus = new EventBus();
    const collector = collectNavigation(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${fixture?.origin ?? ""}/`, { waitUntil: "load" });
      await telemetry.drain(300);

      // The frame AND target the SPA is running in, learned from what
      // telemetry saw. Hardcoding a target id looked fine and silently
      // attributed nothing, because frames are keyed by both.
      const landed = collector.model.navigations.at(-1);
      expect(landed?.frameId).toBeDefined();

      await bus.publish({
        type: "interaction",
        provenance: "observed",
        auth_context: "anonymous",
        payload: {
          interactionId: "int_0001",
          frameId: landed?.frameId,
          targetId: landed?.targetId,
        },
      });
      await page.click("#to-orders");
      await telemetry.drain(400);

      const orders = collector.model.navigations.find((navigation) =>
        navigation.to.endsWith("/app/orders"),
      );
      expect(orders?.interactionId).toBe("int_0001");
      expect(orders?.attributionBasis).toBe("most_recent_interaction");

      await page.close();
    } finally {
      await telemetry.detach();
      collector.stop();
    }
  });

  browserTest("declines to attribute a route change that followed no interaction", async () => {
    // `#auto` defers its pushState past the click's own task. Handing it the
    // nearest interaction anyway is the mistake that makes an attribution
    // field worse than no field.
    const model = await drive(async (page) => {
      await page.evaluate(() => {
        history.pushState({}, "", "/app/auto");
      });
    });

    const auto = model.navigations.find((navigation) => navigation.to.endsWith("/app/auto"));
    expect(auto?.kind).toBe("soft");
    expect(auto?.interactionId).toBeUndefined();
    expect(auto?.attributionBasis).toBe("none");
  });

  browserTest("still calls a real document load hard", async () => {
    const model = await drive(async (page) => {
      await page.goto(`${fixture?.origin ?? ""}/second`, { waitUntil: "load" });
    });

    const second = model.navigations.find((navigation) => navigation.to.endsWith("/second"));
    expect(second?.kind).toBe("hard");
    expect(second?.from).toBe(`${fixture?.origin ?? ""}/`);
  });
});
