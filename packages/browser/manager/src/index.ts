/**
 * @browserrecon/browser-manager — Chrome lifecycle.
 *
 * Launches an isolated, per-scan Chrome and guarantees it goes away again.
 * Build plan §6, §22.3; dev plan BR-M1-01.
 *
 * This is the driver boundary: the one package that knows BrowserRecon drives
 * Chrome through puppeteer-core. The substitutable control interface §5.1 asks
 * for is built on top of it in BR-M1-02, and everything above that should
 * import the adapter rather than this.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/browser-manager" as const;

export { BrowserLaunchError, launchBrowser, withBrowser } from "./manager.js";
export type { BrowserSession, LaunchOptions } from "./manager.js";

export {
  CHROME_COMMANDS,
  CHROME_PATH_ENV,
  CHROME_PATHS,
  resolveChromePath,
} from "./chrome-path.js";
export type { ChromeLocation, ChromeProbes, ChromeSource } from "./chrome-path.js";

export { BASE_FLAGS, HEADED_FLAGS, buildFlags } from "./flags.js";
export type { BuildFlagsInput } from "./flags.js";

export { createProfile, removeProfile, sweepOrphanProfiles } from "./profile.js";
export type { Profile, SweepResult } from "./profile.js";
