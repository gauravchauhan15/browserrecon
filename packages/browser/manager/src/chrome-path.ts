/**
 * Finding Chrome — build plan §25, §42.
 *
 * This lives in the browser package rather than in the `doctor` command
 * because the two need the *same* answer. `doctor` tells a user whether a scan
 * will find a browser; the manager then has to find the same one. Two copies
 * of this list would eventually disagree, and the failure would look like
 * "doctor says Chrome is fine but the scan cannot start it" — which sends the
 * reader hunting in entirely the wrong place.
 *
 * ## Why the app bundle is checked before PATH
 *
 * On macOS the normal Chrome install puts nothing on `PATH`. A `which` lookup
 * alone therefore reports "not installed" on a machine that plainly has it.
 * On Linux the reverse is true, so both are checked, bundles first.
 *
 * ## Why nothing is ever downloaded
 *
 * `puppeteer-core` is used rather than `puppeteer` precisely because the
 * latter downloads a ~150 MB Chrome build during `pnpm install`. §25.2 is
 * explicit that BrowserRecon never pulls a large binary on the user's behalf,
 * and a security tool that fetches its own browser at install time is asking
 * for trust it has not earned. We use the Chrome the user already chose to
 * install, or we say clearly that we cannot find one.
 */

/** Injected so detection is testable on a machine of any shape. */
export interface ChromeProbes {
  readonly fileExists: (path: string) => boolean;
  /** Run a command, returning its output, or undefined if it cannot run. */
  readonly runCommand: (
    command: string,
    args: readonly string[],
  ) => { readonly stdout: string } | undefined;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Where Chrome usually lives, by platform, in preference order.
 *
 * Branded Chrome first, then Chrome for Testing, then Chromium: a user with
 * several installed almost certainly means the one they browse with, and
 * §10C.7 notes that a real branded build is less often bot-detected.
 */
export const CHROME_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
};

/** Names to try on `PATH` when no bundle is found. */
export const CHROME_COMMANDS: readonly string[] = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

/** The environment variable that overrides detection (`browser.executablePath`). */
export const CHROME_PATH_ENV = "BROWSERRECON_CHROME_PATH";

export type ChromeSource = "configured" | "bundle" | "path";

export type ChromeLocation =
  | {
      readonly found: true;
      readonly executablePath: string;
      readonly source: ChromeSource;
      /** Version banner, when the binary would report one. */
      readonly version?: string | undefined;
    }
  | { readonly found: false; readonly reason: string; readonly remedy: string };

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * Locate a Chrome to drive.
 *
 * An explicitly configured path that does not exist is an error rather than a
 * reason to fall back: the user named a specific build, and quietly driving a
 * different one would make every observation describe a browser they did not
 * choose.
 */
export function resolveChromePath(
  probes: ChromeProbes,
  configuredPath?: string | undefined,
): ChromeLocation {
  const configured = configuredPath ?? probes.env[CHROME_PATH_ENV];

  if (configured !== undefined && configured !== "") {
    if (!probes.fileExists(configured)) {
      return {
        found: false,
        reason: `configured Chrome path does not exist: ${configured}`,
        // Names the offending path, so the remedy line alone is actionable —
        // a user reading "fix the variable" still has to go and find what it
        // is currently set to.
        remedy:
          `${CHROME_PATH_ENV} (or browser.executablePath) points at ${configured}, ` +
          "which does not exist. Correct it, or unset it to auto-detect.",
      };
    }
    const version = probes.runCommand(configured, ["--version"]);
    return {
      found: true,
      executablePath: configured,
      source: "configured",
      ...(version === undefined ? {} : { version: firstLine(version.stdout) }),
    };
  }

  for (const path of CHROME_PATHS[probes.platform] ?? []) {
    if (!probes.fileExists(path)) continue;
    const version = probes.runCommand(path, ["--version"]);
    return {
      found: true,
      executablePath: path,
      source: "bundle",
      ...(version === undefined ? {} : { version: firstLine(version.stdout) }),
    };
  }

  for (const command of CHROME_COMMANDS) {
    const version = probes.runCommand(command, ["--version"]);
    if (version === undefined) continue;
    // Resolve to an absolute path rather than handing over a bare name.
    // `spawn` would resolve it via PATH anyway, but then the path Chrome was
    // actually started from never appears in a log or an error — and "which
    // Chrome did it use?" is a question that comes up the moment a scan
    // behaves oddly. `which`/`where` are real binaries; `command -v` is a
    // shell builtin and probes never spawn a shell.
    const locator = probes.platform === "win32" ? "where" : "which";
    const resolved = probes.runCommand(locator, [command]);
    return {
      found: true,
      executablePath: firstLine(resolved?.stdout ?? "") || command,
      source: "path",
      version: firstLine(version.stdout),
    };
  }

  return {
    found: false,
    reason: "no Chrome or Chromium found",
    remedy:
      `Install Chrome or Chromium, or set ${CHROME_PATH_ENV} to an existing binary. ` +
      "https://www.google.com/chrome",
  };
}
