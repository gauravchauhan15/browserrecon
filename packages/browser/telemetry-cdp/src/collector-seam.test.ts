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
import { restApi, startFixture, staticSite, type RunningFixture } from "@browserrecon/fixtures";
import { attachTelemetry } from "@browserrecon/telemetry-cdp";
import { EventBus } from "@browserrecon/events";
import { collectNetwork, type NetworkModel } from "@browserrecon/collector-network";

/**
 * The seam between telemetry and the network collector, end to end:
 * browser → CDP → bus → collector.
 *
 * The collector's own tests publish events by hand, which is right — it
 * consumes a bus and should not need a browser. What they cannot check is that
 * the payload *shapes* it expects are the ones telemetry actually emits, and
 * no type catches that either: both sides describe the payload independently,
 * and a renamed field would type-check on both.
 *
 * It lives here rather than in the collector because holding a browser handle
 * is confined to `packages/browser/**` (§32.10, enforced by eslint) — a rule
 * that caught this file when it was in the wrong package, which is the point
 * of having it.
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

describe("against a real browser", () => {
  let site: RunningFixture | undefined;
  let api: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    site = await startFixture(staticSite());
    api = await startFixture(restApi());
    session = await launchBrowser({
      sessionId: "sess_0001",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-collector-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await site?.close();
    await api?.close();
  });

  /** Visit a path, collect, and return the model. */
  async function visit(
    path: string,
    then?: (origin: string) => Promise<void>,
  ): Promise<NetworkModel> {
    const bus = new EventBus();
    const collector = collectNetwork(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${site?.origin ?? ""}${path}`, { waitUntil: "networkidle2" });
      if (then !== undefined) {
        await page.evaluate(async (base: string) => {
          await Promise.all([
            fetch(`${base}/api/v1/products`),
            fetch(`${base}/api/v1/products/2`),
            fetch(`${base}/api/v1/nope`),
          ]);
        }, api?.origin ?? "");
      }
      await telemetry.drain(400);
      await page.close();
      return collector.model;
    } finally {
      await telemetry.detach();
      collector.stop();
    }
  }

  browserTest("joins the document request to its response", async () => {
    const model = await visit("/");
    const document = model.observations.find((o) => o.url.path === "/");

    expect(document?.method).toBe("GET");
    expect(document?.status).toBe(200);
    expect(document?.mimeType).toBe("text/html");
    expect(document?.bodyCaptured).toBe(true);
    // The fields telemetry promises are the fields the collector reads.
    expect(document?.remoteIpAddress).toBe("127.0.0.1");
    expect(document?.initiatorType).toBeDefined();
  });

  browserTest("groups a cross-origin fetch under its own origin", async () => {
    // Two fixtures on two ports. A model that merged them would report one
    // application's endpoints as another's.
    const model = await visit("/", async () => undefined);

    const origins = model.origins.map((group) => group.origin);
    expect(origins).toContain(site?.origin);
    expect(origins).toContain(api?.origin);
    expect(site?.origin).not.toBe(api?.origin);

    const apiGroup = model.origins.find((group) => group.origin === api?.origin);
    expect(apiGroup?.endpoints.size).toBe(3);
    expect(apiGroup?.statuses).toEqual([200, 404]);
  });

  browserTest("records a 404 as a status, not a failure", async () => {
    // The server answered. §33 treats a barrier as a normal outcome.
    const model = await visit("/", async () => undefined);
    const apiGroup = model.origins.find((group) => group.origin === api?.origin);

    expect(apiGroup?.failures).toBe(0);
    expect(
      model.observations.some((o) => o.url.path === "/api/v1/nope" && o.status === 404),
    ).toBe(true);
  });

  browserTest("classifies a real connection failure", async () => {
    const bus = new EventBus();
    const collector = collectNetwork(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${site?.origin ?? ""}/`, { waitUntil: "domcontentloaded" });
      await page
        .evaluate(async () => {
          // Port 1 is reserved and never listening.
          await fetch("http://127.0.0.1:1/unreachable").catch(() => undefined);
        })
        .catch(() => undefined);
      await telemetry.drain(400);

      const failed = collector.model.observations.filter((o) => o.failure !== undefined);
      expect(failed.length).toBeGreaterThan(0);
      // Chrome's own string survives classification, and the reason is from
      // the published set rather than a raw string.
      expect(failed[0]?.failure?.raw).toContain("ERR_");
      expect(failed[0]?.failure?.reason).not.toBe("");

      await page.close();
    } finally {
      await telemetry.detach();
      collector.stop();
    }
  });

  browserTest("finds the JS-only endpoints once the page fetches them", async () => {
    // /app.js references /api/v1/cart by concatenation. The collector sees it
    // only if the page actually calls it — which is the difference between
    // static discovery and runtime observation the whole tool rests on.
    const bus = new EventBus();
    const collector = collectNetwork(bus);
    const telemetry = await attachTelemetry({
      browser: (session as BrowserSession).browser,
      bus,
    });

    try {
      const page = await (session as BrowserSession).browser.newPage();
      await page.goto(`${site?.origin ?? ""}/`, { waitUntil: "domcontentloaded" });
      await page.evaluate(async (base: string) => {
        await fetch(`${base}/api/v1/cart`);
      }, api?.origin ?? "");
      await telemetry.drain(400);

      const cart = collector.model.observations.find((o) => o.url.path === "/api/v1/cart");
      expect(cart?.status).toBe(200);
      expect(cart?.initiatorType).toBe("script");

      await page.close();
    } finally {
      await telemetry.detach();
      collector.stop();
    }
  });
});
