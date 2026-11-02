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
import {
  startFixture,
  staticSite,
  restApi,
  throttledApi,
  webmcpMapSite,
  WEBMCP_MAP_TOOLS,
  type RunningFixture,
} from "@browserrecon/fixtures";
import { PolicyEngine, defaultTargetPolicy, type TargetPolicy } from "@browserrecon/policy";
import { PuppeteerBrowserAdapter, policyActionFor } from "./puppeteer-adapter.js";
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
        await adapter.harvest();

        const kinds = new Set(engine.asked.map((entry) => entry.kind));
        for (const action of ADAPTER_ACTIONS) {
          // The *policy's* name: `harvest` asks about `inspect_page`. What
          // must hold is that something was asked, not that the two
          // vocabularies happen to coincide.
          expect(kinds, `${action} reached the page without a policy check`).toContain(
            policyActionFor(action),
          );
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
    "answers within its budget rather than hanging, whatever the driver does",
    async () => {
      // The adapter promises every action answers inside its timeout. The
      // driver does not: ElementHandle.click takes no timeout, and when the
      // click causes a navigation its underlying CDP calls can be left waiting
      // on an execution context that no longer exists. Observed as a
      // form-submitting click hanging past sixty seconds on a loaded machine
      // while passing in isolation — so the budget is enforced by the adapter
      // rather than hoped for.
      const origin = fixture?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        await adapter.navigate(`${origin}/contact`);
        const started = Date.now();
        const result = await adapter.click('input[name="email"]', { timeoutMs: 1 });

        // Either it beat the deadline or it reported a typed failure. What it
        // must never do is take materially longer than asked.
        expect(["ok", "failed"]).toContain(result.status);
        expect(Date.now() - started).toBeLessThan(5_000);
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

describe("a page the browser is still loading", () => {
  let slow: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    slow = await startFixture(throttledApi());
    session = await launchBrowser({
      sessionId: "sess_0005",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-adapter-slow-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await slow?.close();
  });

  browserTest(
    "is kept when the load times out after the document committed",
    async () => {
      // the reference application did not reach `domcontentloaded` inside the action
      // budget. `goto` threw, the navigation was recorded as failed, and the
      // scan reported "no page was loaded" over a log already holding 126
      // requests and 23 parsed bundles — nothing was harvested, so the whole
      // DOM and agentic surface was silently missing from the report.
      //
      // `/api/never` commits headers and a first chunk and then never ends,
      // which is that page without the fourteen-second wait.
      const origin = slow?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const result = await adapter.navigate(`${origin}/api/never`, { timeoutMs: 2_000 });
        expect(result.status, "a committed document was discarded").toBe("ok");
        if (result.status !== "ok") return;
        expect(result.value.url).toBe(`${origin}/api/never`);
        // Said out loud: a page read mid-load may be thin, and a scan that
        // cannot tell "visited" from "visited in full" reports the second.
        expect(result.value.loadTimedOut).toBe(true);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  browserTest(
    "is still a failure when nothing committed at all",
    async () => {
      // The other half of the rule above, and the one that keeps it honest.
      // A navigation that times out before it commits leaves the *previous*
      // page in the tab. Treating that as success files the old page's
      // links, forms and tools under the new URL — a scan reporting a page
      // the browser never opened, which is the failure this adapter's own
      // redirect check exists to prevent.
      const origin = slow?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        const first = await adapter.navigate(`${origin}/api/items`);
        expect(first.status).toBe("ok");

        // Too little time to commit anything, from a page that is already
        // loaded — so `page.url()` still reads as the previous page.
        const result = await adapter.navigate(`${origin}/api/never`, { timeoutMs: 1 });
        expect(result.status, "an uncommitted navigation was reported as a visit").toBe(
          "failed",
        );
        expect(adapter.currentUrl).toBe(`${origin}/api/items`);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );
});

describe("a tool registry published late", () => {
  let site: RunningFixture | undefined;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    if (!chrome.found) return;
    site = await startFixture(webmcpMapSite());
    session = await launchBrowser({
      sessionId: "sess_0006",
      probes,
      profileRoot: mkdtempSync(join(tmpdir(), "br-adapter-late-")),
      sweepOrphans: false,
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await site?.close();
  });

  browserTest(
    "is waited for, rather than read past",
    async () => {
      // A registry is published by script, and the scripts that publish one
      // run late: the reference application defined `navigator.modelContext` about nine
      // seconds after navigation and registered its five tools later again.
      // The harvest read the page at `domcontentloaded` and found nothing,
      // which the report printed as "this page published no tools".
      //
      // Every fixture registry used to appear in the first tick, so no test
      // could tell a harvest that waits from one that does not. This one
      // arrives on a timer, and the tools after it — which also covers the
      // in-between state, a registry object present and still empty.
      const origin = site?.origin ?? "";
      const engine = new PolicyEngine(policyFor(origin));
      const adapter = await PuppeteerBrowserAdapter.create({
        session: session as BrowserSession,
        engine,
      });

      try {
        expect((await adapter.navigate(`${origin}/`)).status).toBe("ok");

        // Deliberately no settle: the harvest is responsible for this, and
        // the fixture's tools are not registered yet at this line.
        const harvested = await adapter.harvest();
        expect(harvested.status).toBe("ok");
        if (harvested.status !== "ok") return;

        expect(harvested.value.webmcpRegistriesSeen).toContain("navigator.modelContext");
        expect(harvested.value.webmcpTools.map((tool) => tool.name).sort()).toEqual(
          WEBMCP_MAP_TOOLS.map((tool) => tool.name).sort(),
        );
      } finally {
        await adapter.close();
      }
    },
    90_000,
  );
});
