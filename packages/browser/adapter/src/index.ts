/**
 * @browserrecon/browser-adapter — the control boundary.
 *
 * Every browser action goes through here, and every one of them is checked
 * against the Target Policy before it happens (§32.10). Build plan §5.1;
 * dev plan BR-M1-02.
 *
 * `BrowserAdapter` (types.ts) names no driver type, which is what lets V5 add
 * a Chrome DevTools MCP implementation beside the Puppeteer one without a
 * caller changing. A test asserts that against the generated declarations.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/browser-adapter" as const;

export { ADAPTER_ACTIONS, FAILURE_KINDS, denied, failed, ok } from "./types.js";
export type {
  ActionOptions,
  ActionResult,
  AdapterAction,
  BrowserAdapter,
  FailureKind,
  NavigationOutcome,
  ScrollDirection,
  SettledOutcome,
} from "./types.js";

export { inferStateChanging, resolveStateChanging } from "./state-changing.js";
export type { AncestorStep, ElementFacts, StateChangeVerdict } from "./state-changing.js";

export { PuppeteerBrowserAdapter, createBrowserAdapter } from "./puppeteer-adapter.js";
export type { PuppeteerAdapterOptions } from "./puppeteer-adapter.js";
