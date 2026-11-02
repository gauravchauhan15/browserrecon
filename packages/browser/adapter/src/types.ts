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
export const ADAPTER_ACTIONS = [
  "navigate",
  "click",
  "type",
  "scroll",
  "back",
  "wait",
  "exists",
  "harvest",
] as const;

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
  /**
   * The document committed but the load did not finish inside the budget.
   *
   * The page is still worth reading — it is in the browser — but the caller
   * is told, because "visited" and "visited in full" are different facts and
   * a scan that cannot tell them apart will report the second for the first.
   */
  readonly loadTimedOut?: boolean | undefined;
}

/** Links, forms and interactive controls as they exist in the page right now. */
export interface PageHarvest {
  /** Absolute URLs, deduplicated, in document order. */
  readonly links: readonly string[];
  readonly forms: readonly HarvestedForm[];
  /**
   * Controls worth interacting with, in document order.
   *
   * Buttons and clickable non-anchor elements. Plain links are in `links`
   * and are reached by navigating, which is cheaper and does not need a
   * click — a control is here because following it means *doing* something.
   *
   * Carried as facts rather than selectors: turning facts into a selector is
   * a pure function (`buildElementReference`), and keeping it out of the
   * browser layer is what makes "reproducible across runs" testable without
   * a browser.
   */
  readonly controls: readonly HarvestedControl[];
  /**
   * WebMCP tools the page has registered — build plan §21.
   *
   * Registering a tool is a JavaScript call that sends nothing, so a page's
   * whole agent-facing action surface is invisible to network telemetry.
   * Read here because the harvest is the one place that looks at the page
   * after its scripts have run.
   */
  readonly webmcpTools: readonly HarvestedWebMcpTool[];
  /**
   * Registries that were present on the page, whether or not any tool was
   * read out of them.
   *
   * §45's no-silent-loss rule. "No registry" and "a registry in a shape this
   * adapter does not understand" used to produce identical output — which is
   * how a production site's four tools went missing without a trace.
   */
  readonly webmcpRegistriesSeen: readonly string[];
  /**
   * The wait for the registry ended on its budget, not on the tools settling.
   *
   * Tools register in a trickle — the reference application's five arrived
   * across eleven
   * seconds — so a wait that runs out may have caught some and missed the
   * rest. A truncated list that reads as complete is the same failure as an
   * empty one that reads as complete, so the caller is told which it has.
   */
  readonly webmcpStillFilling: boolean;
  /** The URL these were read from, which may differ from the one requested. */
  readonly url: string;
}

/**
 * One registered tool, in our shape rather than the draft's.
 *
 * §21 keeps the spec behind an adapter because it is young and moving: every
 * field here is optional except the name, and an unrecognised registry shape
 * yields nothing rather than failing the harvest.
 */
export interface HarvestedWebMcpTool {
  readonly name: string;
  readonly description?: string | undefined;
  /** The declared input schema, as JSON. Opaque on purpose. */
  readonly inputSchema?: unknown;
  /** What the tool returns to an agent — data exposure, not just input. */
  readonly outputSchema?: unknown;
  /** The endpoint the tool says it calls, where it says so. */
  readonly endpoint?: string | undefined;
  /**
   * MCP tool annotations, where the page supplies them.
   *
   * `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`,
   * `untrustedContentHint`. §7.2's whole point: a tool the page itself marks
   * as not read-only is a destructive operation published to any visiting
   * agent, and that is something to report prominently — never to invoke.
   */
  readonly annotations?: Record<string, unknown> | undefined;
  /** Which registry it came from, so a changing spec is visible in the log. */
  readonly registry: string;
}

/** An interactive control, with the facts a reference is derived from. */
export interface HarvestedControl {
  /** Document order, so the same page yields the same order every run. */
  readonly index: number;
  readonly facts: ElementFacts;
  /**
   * The form it submits, when it is a submit control.
   *
   * Present means clicking it submits that form, so the form's own
   * classification decides whether the click is allowed at all.
   */
  readonly submitsForm?: HarvestedForm | undefined;
}

export interface HarvestedForm {
  readonly id?: string | undefined;
  readonly method: string;
  /** Resolved against the page, so it is comparable with a link. */
  readonly action: string;
  readonly fields: readonly { readonly name: string; readonly type: string }[];
  readonly submitText?: string | undefined;
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
  /**
   * Read what the page currently offers: links and forms.
   *
   * An observation, not an action. It goes through the adapter rather than a
   * raw page handle because §32.10 confines the driver to this boundary —
   * and because reading the *live* DOM is the whole point. The markup a
   * crawler fetches for `dynamic-site` has two links; the page has six.
   */
  /**
   * Whether an element matching `selector` is in the document.
   *
   * A read, and the only honest way to test an authentication success
   * condition: "a selector that exists only when signed in" cannot be checked
   * by clicking it. Policy sees this as `inspect_page`, the same as `harvest`.
   */
  exists(selector: string, options?: ActionOptions): Promise<ActionResult<boolean>>;
  harvest(options?: ActionOptions): Promise<ActionResult<PageHarvest>>;
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
