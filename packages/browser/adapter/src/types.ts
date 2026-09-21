/**
 * The control boundary — build plan §5.1, §32.10; dev plan BR-M1-02.
 *
 * This file is the contract everything above the browser layer talks to, and
 * it is deliberately free of any driver type. §5.1 splits *control* from
 * *telemetry* so the thing that makes the browser act can be replaced —
 * Puppeteer today, Chrome DevTools MCP for the AI Explorer in V5 — without the
 * observation path noticing. That substitution only stays possible if no
 * Puppeteer type ever reaches a signature here, which a test asserts against
 * the generated declarations rather than trusting to review.
 *
 * ## Nothing here throws for a denial or a miss
 *
 * Every method returns an `ActionResult`. A scan spends its life doing things
 * that legitimately do not work — a selector that no longer matches, a link
 * the policy forbids, a page that times out — and each of those is an
 * *observation*, not an exception. Exceptions would force every caller into
 * try/catch to distinguish "the policy said no" from "the tool broke", and the
 * two demand completely different responses: one is recorded as a barrier
 * (§8.6) and the scan continues, the other is a bug.
 *
 * §32.10 — policy validation occurs before browser actions — is enforced by
 * this being the only way in. The Puppeteer handle stays private to the
 * implementation, and an eslint rule stops anything outside the browser
 * packages importing the driver directly.
 */
import type { BarrierCategory, DenialReason } from "@browserrecon/policy";
import type { ElementFacts } from "./state-changing.js";

/** Actions the adapter can perform. A subset of the policy's permitted set. */
export const ADAPTER_ACTIONS = ["navigate", "click", "type", "scroll", "back", "wait"] as const;

export type AdapterAction = (typeof ADAPTER_ACTIONS)[number];

/** Why an attempted action did not complete, distinct from being forbidden. */
export const FAILURE_KINDS = [
  /** The selector matched nothing. */
  "element_not_found",
  /** The element was there but not actionable — hidden, disabled, covered. */
  "element_not_interactable",
  /** The action did not finish inside its budget. */
  "timeout",
  /** The browser reported a navigation error: DNS, TLS, connection refused. */
  "navigation_failed",
  /** The browser is gone. */
  "browser_closed",
  /** Anything the driver raised that does not map to the above. */
  "driver_error",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export type ActionResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | {
      readonly status: "denied";
      readonly action: AdapterAction;
      readonly reason: DenialReason;
      /** One line, safe to show a user. */
      readonly detail: string;
      /** How a coverage report should categorise this (§8.6). */
      readonly barrier: BarrierCategory;
    }
  | {
      readonly status: "failed";
      readonly action: AdapterAction;
      readonly kind: FailureKind;
      readonly detail: string;
    };

/** Where the browser ended up. Plain data, deliberately not a driver object. */
export interface NavigationOutcome {
  /** The URL actually landed on, after any redirects the browser followed. */
  readonly url: string;
  readonly httpStatus?: number | undefined;
  /** True when the final URL differs from the one requested. */
  readonly redirected: boolean;
}

export interface SettledOutcome {
  /** Milliseconds spent waiting. */
  readonly waitedMs: number;
  /** False when the budget ran out before the page went quiet. */
  readonly settled: boolean;
}

export type ScrollDirection = "up" | "down" | "top" | "bottom";

export interface ActionOptions {
  /**
   * Whether this action changes application state.
   *
   * The caller's declaration is a *floor*, never a ceiling: the adapter also
   * inspects the element and takes whichever answer is stricter. A caller that
   * forgets the flag on a delete button must not get a permissive default —
   * that is precisely the mistake a policy layer exists to survive.
   */
  readonly stateChanging?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * The control interface (§5.1).
 *
 * Implementations own a driver; callers never see one. `BR-M1-12`'s
 * Deterministic Explorer and V5's AI Explorer both drive the browser through
 * this and nothing else.
 */
export interface BrowserAdapter {
  /** Where the browser currently is. `about:blank` before the first navigate. */
  readonly currentUrl: string;

  navigate(url: string, options?: ActionOptions): Promise<ActionResult<NavigationOutcome>>;
  /**
   * Click an element.
   *
   * Returns what the element turned out to be. The adapter has to read the
   * DOM anyway to decide whether the click changes state, and that read
   * cannot be repeated afterwards — by the time anything else looks, the page
   * has moved on and the element that was clicked may not exist. So the facts
   * come back with the result, and the interaction collector (BR-M1-08) turns
   * them into a stable reference.
   */
  click(selector: string, options?: ActionOptions): Promise<ActionResult<ElementFacts>>;
  type(selector: string, text: string, options?: ActionOptions): Promise<ActionResult<void>>;
  scroll(direction: ScrollDirection, options?: ActionOptions): Promise<ActionResult<void>>;
  back(options?: ActionOptions): Promise<ActionResult<NavigationOutcome>>;
  /** Wait for the page to stop changing, so observation sees a stable state. */
  waitForSettled(options?: ActionOptions): Promise<ActionResult<SettledOutcome>>;
  /** Release the page. Does not close the browser — the manager owns that. */
  close(): Promise<void>;
}

/** Build a denial result from a policy decision. */
export function denied<T>(
  action: AdapterAction,
  decision: { reason: DenialReason; detail: string; barrier: BarrierCategory },
): ActionResult<T> {
  return {
    status: "denied",
    action,
    reason: decision.reason,
    detail: decision.detail,
    barrier: decision.barrier,
  };
}

export function failed<T>(
  action: AdapterAction,
  kind: FailureKind,
  detail: string,
): ActionResult<T> {
  return { status: "failed", action, kind, detail };
}

export function ok<T>(value: T): ActionResult<T> {
  return { status: "ok", value };
}
