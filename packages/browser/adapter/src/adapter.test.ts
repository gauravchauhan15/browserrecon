/// <reference lib="dom" />
//
// DOM lib for this file alone: the assertions read page state through
// `page.evaluate`, whose bodies run in the browser.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  launchBrowser,
  resolveChromePath,
  type BrowserSession,
  type ChromeProbes,
} from "@browserrecon/browser-manager";
import { startFixture, staticSite, restApi, type RunningFixture } from "@browserrecon/fixtures";
import { PolicyEngine, defaultTargetPolicy, type TargetPolicy } from "@browserrecon/policy";
import { PuppeteerBrowserAdapter } from "./puppeteer-adapter.js";
import { ADAPTER_ACTIONS, type ActionResult } from "./types.js";

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
    if (CI) {
      expect(
        chrome.found,
        "no Chrome in CI; these tests must not be skipped in automation",
      ).toBe(true);
    }
    expect(true).toBe(true);
  });
});

/**
 * A Policy Engine that records what it was asked.
 *
 * §32.10 says policy validation happens before browser actions. Counting the
 * calls is how that gets proven per method — an adapter method that forgot to
 * ask would still *work*, and no behavioural assertion would notice.
 */
class RecordingEngine extends PolicyEngine {
  readonly asked: {
    kind: string;
    url?: string | undefined;
    stateChanging?: boolean | undefined;
  }[] = [];

  override canAct(action: Parameters<PolicyEngine["canAct"]>[0]) {
    this.asked.push({
      kind: action.kind,
      url: action.url,
      stateChanging: action.stateChanging,
    });
    return super.canAct(action);
  }
}

/**
 * The policy a bare `browserrecon scan <origin>` runs under.
 *
 * `defaultTargetPolicy` returns a resolution, not a policy — it can fail on a
 * malformed origin. Unwrapping loudly here means a typo in a test's origin
 * surfaces as that, rather than as an undefined field deep inside the engine.
 */
function policyFor(origin: string, overrides: Partial<TargetPolicy> = {}): TargetPolicy {
  const resolved = defaultTargetPolicy(origin);
  if (!resolved.ok) {
    throw new Error(
      `test policy is invalid for ${origin}: ${JSON.stringify(resolved.violations)}`,
    );
  }
  return {
    ...resolved.policy,
    // Fixtures listen on 127.0.0.1, and the default policy refuses loopback —
    // correctly, because a tool pointed at a public URL reaching localhost is
    // either a mistake or SSRF-shaped. Writing these tests is the same
    // experience a user scanning their own dev server has: the refusal is the
    // designed behaviour, and getting past it takes saying so explicitly.
    // Asserted as a behaviour of its own below, rather than only worked around.
    network: { ...resolved.policy.network, denyLoopback: false },
    ...overrides,
  };
}

describe("every action asks the policy first", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(staticSite());
    session = await launchBrowser({
      sessionId: "sess_0001",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-adapter-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest(
    "consults the engine on navigate, click, type, scroll, back and wait",
    async () => {
      // The acceptance criterion, method by method. If a new action is added
      // to ADAPTER_ACTIONS without a policy check, this fails.
      const origin = fixture?.origin ?? "";
      const engine = new RecordingEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        await adapter.navigate(`${origin}/products`);
        await adapter.click('a[href="/products/1"]');
        await adapter.scroll("bottom");
        await adapter.back();
        await adapter.waitForSettled({ timeoutMs: 1_000 });
        await adapter.navigate(`${origin}/contact`);
        await adapter.type('input[name="email"]', "someone@example.com");

        const kinds = new Set(engine.asked.map((entry) => entry.kind));
        for (const action of ADAPTER_ACTIONS) {
          expect(kinds, `${action} reached the page without a policy check`).toContain(action);
        }
      } finally {
        await adapter.close();
      }
    },
    90_000,
  );

  browserTest(
    "asks before acting, not after",
    async () => {
      // "Validation occurs before the action" (§32.10) — an adapter that acted
      // first and checked afterwards would pass a call-count test while being
      // exactly wrong.
      const origin = fixture?.origin ?? "";
      const engine = new RecordingEngine(policyFor("https://elsewhere.example.com"));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const before = adapter.currentUrl;
        const result = await adapter.navigate(`${origin}/products`);

        expect(result.status).toBe("denied");
        // The browser never moved.
        expect(adapter.currentUrl).toBe(before);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );
});

describe("denials are typed, never thrown", () => {
  let fixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(staticSite());
    session = await launchBrowser({
      sessionId: "sess_0002",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-adapter-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
  });

  browserTest(
    "returns a denial carrying reason, detail and barrier category",
    async () => {
      // A scan does forbidden things constantly — that is how it discovers the
      // boundary. Throwing would force every caller into try/catch to tell
      // "the policy said no" from "the tool broke", which need opposite
      // responses: one is a recorded barrier (§8.6), the other is a bug.
      const engine = new PolicyEngine(policyFor(fixture?.origin ?? ""));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const result = await adapter.navigate("https://not-in-scope.example.com/");
        expect(result.status).toBe("denied");
        if (result.status !== "denied") return;

        expect(result.action).toBe("navigate");
        expect(result.reason).toBe("origin_not_allowed");
        expect(result.detail).toContain("not-in-scope.example.com");
        // §8.6: a coverage report must distinguish "you told us not to" from
        // "we could not reach it".
        expect(result.barrier).toBe("scope_excluded");
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "refuses a submit button under the default read-only policy",
    async () => {
      // The default policy forbids state-changing actions. The adapter works
      // out that a bare <button> inside a form is a submit, without the caller
      // having to say so.
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        await adapter.navigate(`${origin}/contact`);
        const result = await adapter.click('button[type="submit"]');

        expect(result.status).toBe("denied");
        if (result.status !== "denied") return;
        expect(result.reason).toBe("action_state_changing_denied");
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "allows that same click when the policy permits state changes",
    async () => {
      // The mirror image, so the refusal above is proven to come from the
      // policy rather than from the adapter being unable to click.
      const origin = fixture?.origin ?? "";
      const base = policyFor(origin);
      const engine = new PolicyEngine({
        ...base,
        allowedMethods: [...base.allowedMethods, "POST"],
        agent: { ...base.agent, stateChangingActions: true },
      });
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        await adapter.navigate(`${origin}/contact`);
        const result = await adapter.click('button[type="submit"]');
        expect(result.status).toBe("ok");
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "reports a missing element as a failure, distinct from a denial",
    async () => {
      // Different causes, different responses. A selector that stopped
      // matching means the page changed; a denial means the scan is at its
      // boundary.
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        await adapter.navigate(`${origin}/`);
        const result = await adapter.click("#nothing-matches-this", { timeoutMs: 500 });

        expect(result.status).toBe("failed");
        if (result.status !== "failed") return;
        expect(result.kind).toBe("element_not_found");
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "refuses loopback by default, which is why every test above opts in",
    async () => {
      // The default posture, asserted rather than merely worked around. A tool
      // that will happily be pointed at localhost is an SSRF primitive; a user
      // scanning their own dev server has to say so, exactly as these tests do.
      const resolved = defaultTargetPolicy(fixture?.origin ?? "");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const engine = new PolicyEngine(resolved.policy);
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const result = await adapter.navigate(`${fixture?.origin ?? ""}/`);
        expect(result.status).toBe("denied");
        if (result.status !== "denied") return;
        expect(result.reason).toBe("loopback_denied");
        expect(result.barrier).toBe("private_network_unreachable");
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "reports an unreachable target as a failure, not a crash",
    async () => {
      const engine = new PolicyEngine(policyFor("http://127.0.0.1:1"));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const result = await adapter.navigate("http://127.0.0.1:1/", { timeoutMs: 5_000 });
        expect(result.status).toBe("failed");
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );
});

describe("driving a fixture", () => {
  let fixture: RunningFixture | undefined;
  let apiFixture: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    fixture = await startFixture(staticSite());
    apiFixture = await startFixture(restApi());
    session = await launchBrowser({
      sessionId: "sess_0003",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-adapter-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.close();
    await apiFixture?.close();
  });

  browserTest(
    "navigates, clicks a link, and goes back",
    async () => {
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const landed = await adapter.navigate(`${origin}/products`);
        expect(landed.status).toBe("ok");
        expect(adapter.currentUrl).toBe(`${origin}/products`);

        expect((await adapter.click('a[href="/products/1"]')).status).toBe("ok");
        await adapter.waitForSettled({ timeoutMs: 2_000 });
        expect(adapter.currentUrl).toBe(`${origin}/products/1`);

        const back = await adapter.back();
        expect(back.status).toBe("ok");
        expect(adapter.currentUrl).toBe(`${origin}/products`);
      } finally {
        await adapter.close();
      }
    },
    90_000,
  );

  browserTest(
    "reports the status of a page that answered an error",
    async () => {
      // A 410 is an observation, not a failure — §33 treats a barrier as a
      // normal outcome and the scan continues.
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const result = await adapter.navigate(`${origin}/gone`);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.value.httpStatus).toBe(410);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "follows a redirect and reports where it landed",
    async () => {
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const result = await adapter.navigate(`${origin}/old-home`);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.value.redirected).toBe(true);
        expect(result.value.url).toBe(`${origin}/`);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "types into a field without submitting it",
    async () => {
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        await adapter.navigate(`${origin}/contact`);
        const result = await adapter.type('input[name="email"]', "tester@example.com");
        expect(result.status).toBe("ok");
        expect(adapter.currentUrl).toBe(`${origin}/contact`);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "reports not settling rather than failing, on a page that never goes quiet",
    async () => {
      // Real applications poll. A scan must carry on against whatever state it
      // has and record that the page did not settle.
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        await adapter.navigate(`${origin}/`);
        const result: ActionResult<unknown> = await adapter.waitForSettled({
          timeoutMs: 1_500,
        });
        expect(result.status).toBe("ok");
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );
});
