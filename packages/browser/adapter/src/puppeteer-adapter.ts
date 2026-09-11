/// <reference lib="dom" />
//
// The DOM lib is referenced for this file alone, not project-wide. The bodies
// passed to `page.evaluate` run inside the browser and legitimately use
// `document` and `window`; making those globals available to every file would
// let Node-context code reference them and still compile.

/**
 * The Puppeteer implementation of the control boundary — dev plan BR-M1-02.
 *
 * The only file in the codebase above the manager that names a driver type.
 * Everything else talks to `BrowserAdapter` (types.ts), which is why V5 can
 * drop a Chrome DevTools MCP implementation beside this one without a single
 * caller changing (§5.1).
 *
 * ## Every method starts with the same three lines
 *
 * Check the policy, return a typed denial if refused, only then touch the
 * page. §32.10 — *policy validation occurs before browser/agent actions* — is
 * not a convention here; it is the shape of every method, and the tests assert
 * it by counting how many times a stub engine was consulted.
 *
 * ## The page is private and stays private
 *
 * `#page` is a genuine private field, so there is no property, cast or
 * structural type that reaches it. Combined with the eslint rule confining
 * driver imports to `packages/browser/**`, a caller wanting to bypass policy
 * has to edit two files that say in their comments why they exist.
 */
import type { Page } from "puppeteer-core";
import type { BrowserSession } from "@browserrecon/browser-manager";
import { silentLogger, type Logger } from "@browserrecon/core";
import type { Decision, PolicyEngine } from "@browserrecon/policy";
import {
  inferStateChanging,
  resolveStateChanging,
  type ElementFacts,
} from "./state-changing.js";
import {
  denied,
  failed,
  ok,
  type ActionOptions,
  type ActionResult,
  type AdapterAction,
  type BrowserAdapter,
  type FailureKind,
  type NavigationOutcome,
  type ScrollDirection,
  type SettledOutcome,
} from "./types.js";

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;

export interface PuppeteerAdapterOptions {
  readonly session: BrowserSession;
  readonly engine: PolicyEngine;
  readonly logger?: Logger | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

/** Map a driver exception onto a typed failure, so nothing opaque escapes. */
function classify(error: unknown): { kind: FailureKind; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  // The error class first, message text second. Puppeteer's timeout for a
  // missing selector reads "Waiting for selector `#x` failed" — no "timeout",
  // no "exceeded" — so matching on wording alone quietly turned every
  // element-not-found into a generic driver error. Class names are stable
  // across versions in a way English sentences are not.
  if (name === "TimeoutError") return { kind: "timeout", detail };
  if (/Timed? ?out|exceeded/i.test(detail)) return { kind: "timeout", detail };
  if (/Session closed|Target closed|Protocol error|detached/i.test(detail)) {
    return { kind: "browser_closed", detail };
  }
  if (/net::|ERR_|NS_ERROR|navigation failed/i.test(detail)) {
    return { kind: "navigation_failed", detail };
  }
  if (/not visible|not clickable|not an Element|intercepted/i.test(detail)) {
    return { kind: "element_not_interactable", detail };
  }
  return { kind: "driver_error", detail };
}

/**
 * Read what the state-change heuristic needs, without leaving the page.
 *
 * A real function, not a string. Puppeteer accepts either, and a string is
 * evaluated as an *expression* — so passing `"(el) => ({...})"` returns the
 * function itself rather than calling it, and the caller silently receives
 * something that is not an ElementFacts at all. That is exactly what happened
 * here, and it surfaced as `accessibleName` being undefined two layers away.
 */
function readFacts(element: Element): ElementFacts {
  const form = element.closest("form");
  const method = (
    element.getAttribute("formmethod") ??
    form?.getAttribute("method") ??
    ""
  ).toLowerCase();

  return {
    tagName: element.tagName.toLowerCase(),
    type: element.getAttribute("type") ?? undefined,
    accessibleName: (
      element.getAttribute("aria-label") ??
      element.getAttribute("value") ??
      element.textContent ??
      ""
    )
      .trim()
      .toLowerCase()
      .slice(0, 200),
    inForm: form !== null,
    href: element.getAttribute("href") ?? undefined,
    nonGetMethod: ["post", "put", "delete", "patch"].includes(method),
  };
}

export class PuppeteerBrowserAdapter implements BrowserAdapter {
  readonly #page: Page;
  readonly #engine: PolicyEngine;
  readonly #log: Logger;
  readonly #timeout: number;

  private constructor(page: Page, options: PuppeteerAdapterOptions) {
    this.#page = page;
    this.#engine = options.engine;
    this.#log = options.logger ?? silentLogger();
    this.#timeout = options.defaultTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  /** Open a page in the session's browser and wrap it. */
  static async create(options: PuppeteerAdapterOptions): Promise<PuppeteerBrowserAdapter> {
    const page = await options.session.browser.newPage();
    return new PuppeteerBrowserAdapter(page, options);
  }

  get currentUrl(): string {
    return this.#page.url();
  }

  /**
   * Ask the policy, and return a denial the caller can record.
   *
   * Every action funnels through here. Keeping it one method means a new
   * action cannot be added without a policy check, because there is no other
   * path to the page.
   */
  #check(
    action: AdapterAction,
    proposal: { url?: string | undefined; stateChanging?: boolean | undefined },
  ): ActionResult<never> | undefined {
    const decision: Decision = this.#engine.canAct({
      kind: action,
      ...(proposal.url === undefined ? {} : { url: proposal.url }),
      ...(proposal.stateChanging === undefined
        ? {}
        : { stateChanging: proposal.stateChanging }),
    });

    if (decision.allowed) return undefined;

    this.#log.info("action denied by policy", {
      action,
      reason: decision.reason,
      ...(proposal.url === undefined ? {} : { url: proposal.url }),
    });
    return denied(action, decision);
  }

  async navigate(
    url: string,
    options: ActionOptions = {},
  ): Promise<ActionResult<NavigationOutcome>> {
    const refusal = this.#check("navigate", { url, ...options });
    if (refusal) return refusal;

    try {
      const response = await this.#page.goto(url, {
        timeout: options.timeoutMs ?? this.#timeout,
        waitUntil: "domcontentloaded",
      });

      const landed = this.#page.url();

      // Redirects are followed by the browser before we get control back, so
      // this detects rather than prevents. A redirect that left scope has
      // already been requested; what we can still do is refuse to keep
      // exploring from there, and say so. Pre-emptive blocking needs request
      // interception at the telemetry layer (BR-M1-03), where every request is
      // already being watched.
      if (landed !== url) {
        const afterRedirect = this.#engine.canVisit(landed);
        if (!afterRedirect.allowed) {
          await this.#page.goto("about:blank").catch(() => undefined);
          return denied("navigate", afterRedirect);
        }
      }

      return ok({
        url: landed,
        httpStatus: response?.status(),
        redirected: landed !== url,
      });
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("navigate", kind, detail);
    }
  }

  async click(selector: string, options: ActionOptions = {}): Promise<ActionResult<void>> {
    const timeout = options.timeoutMs ?? this.#timeout;

    let facts: ElementFacts;
    try {
      const element = await this.#page.waitForSelector(selector, { timeout });
      if (element === null) {
        return failed("click", "element_not_found", `no element matches ${selector}`);
      }
      facts = await element.evaluate(readFacts);
    } catch (error) {
      const { kind, detail } = classify(error);
      // A selector that never appears is the ordinary case, not an error worth
      // a stack trace — it is how a scan learns the page changed.
      return failed("click", kind === "timeout" ? "element_not_found" : kind, detail);
    }

    // Inspect first, ask second. The policy question depends on what the
    // element turns out to be, so the DOM read has to come before the check —
    // it is a read, and reading is not an action the policy governs.
    const verdict = resolveStateChanging(options.stateChanging, inferStateChanging(facts));
    const refusal = this.#check("click", { stateChanging: verdict.stateChanging });
    if (refusal) {
      this.#log.info("click refused", { selector, because: verdict.because });
      return refusal;
    }

    try {
      await this.#page.click(selector, { delay: 0 });
      return ok(undefined);
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("click", kind, detail);
    }
  }

  async type(
    selector: string,
    text: string,
    options: ActionOptions = {},
  ): Promise<ActionResult<void>> {
    // Typing fills a field; it does not submit one. Treated as non-state-
    // changing unless the caller says otherwise, because refusing to type
    // would make every form unobservable while changing nothing on the server.
    const refusal = this.#check("type", { ...options });
    if (refusal) return refusal;

    try {
      await this.#page.waitForSelector(selector, {
        timeout: options.timeoutMs ?? this.#timeout,
      });
      await this.#page.type(selector, text, { delay: 0 });
      return ok(undefined);
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("type", kind === "timeout" ? "element_not_found" : kind, detail);
    }
  }

  async scroll(
    direction: ScrollDirection,
    options: ActionOptions = {},
  ): Promise<ActionResult<void>> {
    const refusal = this.#check("scroll", { ...options });
    if (refusal) return refusal;

    try {
      await this.#page.evaluate((where: string) => {
        const amount = window.innerHeight * 0.9;
        if (where === "top") window.scrollTo({ top: 0 });
        else if (where === "bottom") window.scrollTo({ top: document.body.scrollHeight });
        else window.scrollBy({ top: where === "up" ? -amount : amount });
      }, direction);
      return ok(undefined);
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("scroll", kind, detail);
    }
  }

  async back(options: ActionOptions = {}): Promise<ActionResult<NavigationOutcome>> {
    const refusal = this.#check("back", { ...options });
    if (refusal) return refusal;

    try {
      const response = await this.#page.goBack({
        timeout: options.timeoutMs ?? this.#timeout,
        waitUntil: "domcontentloaded",
      });

      const landed = this.#page.url();
      if (response === null) {
        // Nothing in the history. Not a failure of the tool — the scan simply
        // cannot go back — so it is reported as an outcome, not an error.
        return ok({ url: landed, redirected: false });
      }

      return ok({ url: landed, httpStatus: response.status(), redirected: false });
    } catch (error) {
      const { kind, detail } = classify(error);
      return failed("back", kind, detail);
    }
  }

  async waitForSettled(options: ActionOptions = {}): Promise<ActionResult<SettledOutcome>> {
    const refusal = this.#check("wait", { ...options });
    if (refusal) return refusal;

    const budget = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const started = Date.now();
    try {
      await this.#page.waitForNetworkIdle({ idleTime: 500, timeout: budget });
      return ok({ waitedMs: Date.now() - started, settled: true });
    } catch (error) {
      const { kind, detail } = classify(error);
      // A page that never goes quiet — polling, a websocket, an animation — is
      // normal on real applications. The scan continues against whatever state
      // it has, and records that it did not settle.
      if (kind === "timeout") {
        return ok({ waitedMs: Date.now() - started, settled: false });
      }
      return failed("wait", kind, detail);
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.#page.isClosed()) await this.#page.close();
    } catch {
      // The browser may already be gone; the manager owns that lifetime and
      // will have cleaned up regardless.
    }
  }
}

/** Convenience factory matching the interface, for callers that want the type. */
export async function createBrowserAdapter(
  options: PuppeteerAdapterOptions,
): Promise<BrowserAdapter> {
  return PuppeteerBrowserAdapter.create(options);
}
