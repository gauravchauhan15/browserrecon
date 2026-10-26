/**
 * @browserrecon/browser-runner — the browsing phase.
 *
 * Holds the browser handle, so it lives under `packages/browser/**` where
 * §32.10 confines it. Matches the orchestrator's `BrowsingPort`
 * structurally rather than importing it, which keeps this layer from
 * depending on the one above.
 */
export const PACKAGE_NAME = "@browserrecon/browser-runner" as const;

export { RunnerBrowserCrash, createRunner } from "./runner.js";
export type { Runner, RunnerOptions, VisitOutcome } from "./runner.js";

export { SKIP_REASONS, decideControl } from "./interact.js";
export type { ControlOutcome, ControlVerdict, DecideOptions, SkipReason } from "./interact.js";

export { createBrowserNativeDiscovery } from "./discovery.js";
export type { BrowserNativeDiscoveryOptions } from "./discovery.js";

export { login } from "./login.js";
export type { LoginInput, LoginOutcome } from "./login.js";
