/**
 * Chrome launch flags — build plan §37.1, §38, §22.3.
 *
 * ## Chrome phones home, and that is our problem
 *
 * A stock Chrome contacts Google on startup and periodically after: component
 * updates, Safe Browsing lists, field trial configuration, domain reliability
 * reporting, translate, the optimization guide. None of it has anything to do
 * with the target, and all of it happens under the banner of a tool whose
 * README promises that nothing leaves the machine (§38) and whose egress guard
 * exists to prove it.
 *
 * Worse, for recon specifically, that traffic lands in the same CDP
 * `Network.*` stream the telemetry adapter subscribes to from V1 (BR-M1-03).
 * Background requests to Google would be recorded as observations of the
 * target's attack surface. Filtering them out afterwards means maintaining a
 * denylist of Google endpoints forever; not generating them is a flag list.
 *
 * Each flag below is here for one of three reasons, and the comment says
 * which: **egress** (stop Chrome talking to anyone but the target),
 * **isolation** (stop state or prompts leaking between scans), or
 * **determinism** (stop the browser varying run to run).
 *
 * Deliberately NOT included:
 *
 *   --no-sandbox            Disabling the sandbox to drive untrusted pages is
 *                           the wrong trade for a security tool. If a
 *                           container needs it, that is the container's
 *                           configuration to make explicit (§22.3 Docker work,
 *                           BR-M7-06), not a default.
 *   --disable-web-security  Would change the very same-origin behaviour the
 *                           scan is supposed to observe.
 *   --incognito             The per-scan profile already provides isolation,
 *                           and incognito changes storage semantics a real
 *                           user would not have.
 */

/** Flags applied to every launch. */
export const BASE_FLAGS: readonly string[] = [
  // --- egress -------------------------------------------------------------
  // The umbrella switch: component updater, domain reliability, and several
  // other background services.
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  // Safe Browsing uploads URLs being visited. On a private staging target that
  // is a disclosure, not a protection.
  "--safebrowsing-disable-auto-update",
  "--disable-client-side-phishing-detection",
  // Field trials are fetched from Google and change browser behaviour between
  // runs — an egress problem and a determinism one at once.
  "--disable-features=OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate,AcceptCHFrame",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-pings",

  // --- isolation ----------------------------------------------------------
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  // A modal — "restore pages?", an infobar, a profile prompt — blocks the
  // explorer on a dialog no one is there to dismiss.
  "--disable-session-crashed-bubble",
  "--disable-infobars",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
  "--use-mock-keychain",

  // --- determinism --------------------------------------------------------
  // Background tabs get throttled timers, which changes what a page does
  // depending on whether the window happened to be focused.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-ipc-flooding-protection",
];

/** Added only when running headed. */
export const HEADED_FLAGS: readonly string[] = [
  // A fixed window size, so a scan's viewport-dependent behaviour does not
  // depend on the developer's monitor.
  "--window-size=1280,900",
];

export interface BuildFlagsInput {
  readonly headless: boolean;
  /** Caller-supplied additions, appended last so they can override. */
  readonly extraArgs?: readonly string[] | undefined;
}

/**
 * The full flag list for a launch.
 *
 * `--user-data-dir` is deliberately absent: it is passed as puppeteer's
 * `userDataDir` option instead, so there is exactly one place that decides
 * where a profile lives (profile.ts) and no way for an `extraArgs` entry to
 * quietly point a scan at a shared profile.
 */
export function buildFlags(input: BuildFlagsInput): string[] {
  return [...BASE_FLAGS, ...(input.headless ? [] : HEADED_FLAGS), ...(input.extraArgs ?? [])];
}
