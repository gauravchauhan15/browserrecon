/**
 * Browser Manager — build plan §6, §22.3; dev plan BR-M1-01.
 *
 * Owns one thing: the lifetime of a Chrome process and the profile it runs
 * against. It decides *that* a browser exists, never *what* it does — the
 * BrowserAdapter (BR-M1-02) and the Deterministic Explorer (§5A) own that, and
 * every action they take passes the Policy Engine first.
 *
 * ## Why the puppeteer type is exposed here and nowhere else
 *
 * §5.1 requires the control interface to carry no Puppeteer types, so that the
 * driver can be substituted. This module is the deliberate exception: it *is*
 * the driver boundary. Handing back the `Browser` lets BR-M1-02 build the
 * abstraction on top without the manager having to guess at its shape first.
 * Nothing above BR-M1-02 should import this package.
 *
 * ## Teardown is the interesting part
 *
 * A launched browser must go away on every path, including the ones nobody
 * plans for. Four cases, handled separately because they fail differently:
 *
 *   caller finishes        `withBrowser` closes in a `finally`
 *   caller throws          same, and the original error is preserved
 *   Chrome dies on its own the `disconnected` event fires; the profile is
 *                          removed and the session is marked closed, so a
 *                          later `close()` is a no-op rather than a hang
 *   the process is killed  cannot be handled here at all — the next launch
 *                          sweeps profiles whose owning pid is gone (profile.ts)
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { launch, type Browser } from "puppeteer-core";
import { silentLogger, type Logger } from "@browserrecon/core";
import { resolveChromePath, type ChromeProbes } from "./chrome-path.js";
import { buildFlags } from "./flags.js";
import { createProfile, removeProfile, sweepOrphanProfiles } from "./profile.js";

/** Chrome is slow to start on a cold page cache and on loaded CI runners. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

export interface LaunchOptions {
  /** Identifies the scan this browser belongs to. Recorded in the profile. */
  readonly sessionId: string;
  readonly probes: ChromeProbes;
  /** Explicit binary, overriding detection (`browser.executablePath`). */
  readonly executablePath?: string | undefined;
  /** §10C.7: headed is often less bot-detected. Headless is the default. */
  readonly headless?: boolean | undefined;
  /** Where profile directories are created. Defaults to the OS temp dir. */
  readonly profileRoot?: string | undefined;
  readonly launchTimeoutMs?: number | undefined;
  readonly extraArgs?: readonly string[] | undefined;
  readonly logger?: Logger | undefined;
  /**
   * Remove stale profiles from dead processes before launching. On by default;
   * off for tests that need to assert on a specific directory's survival.
   */
  readonly sweepOrphans?: boolean | undefined;
}

/** Thrown when no browser could be started. Carries a fixable reason. */
export class BrowserLaunchError extends Error {
  constructor(
    override readonly message: string,
    readonly remedy: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}

export interface BrowserSession {
  /**
   * The driver handle. See the module note — this is the one place a
   * puppeteer type crosses a package boundary.
   */
  readonly browser: Browser;
  readonly profileDir: string;
  readonly executablePath: string;
  readonly sessionId: string;
  /** Whether the browser is gone, by our doing or its own. */
  readonly closed: boolean;
  /** Close the browser and remove the profile. Safe to call more than once. */
  close(): Promise<void>;
}

export async function launchBrowser(options: LaunchOptions): Promise<BrowserSession> {
  const log = options.logger ?? silentLogger();
  const root = options.profileRoot ?? tmpdir();

  if (options.sweepOrphans !== false) {
    const swept = sweepOrphanProfiles(root);
    if (swept.removed.length > 0) {
      log.info("removed profiles left by earlier runs", { count: swept.removed.length });
    }
  }

  const chrome = resolveChromePath(options.probes, options.executablePath);
  if (!chrome.found) {
    throw new BrowserLaunchError(chrome.reason, chrome.remedy);
  }

  const headless = options.headless ?? true;
  const profile = createProfile(options.sessionId, root);

  let browser: Browser;
  try {
    browser = await launch({
      executablePath: chrome.executablePath,
      headless,
      // The isolation guarantee, in one option. Passed here rather than as a
      // flag so no caller-supplied argument can redirect it (see flags.ts).
      userDataDir: profile.dir,
      args: buildFlags({
        headless,
        ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
      }),
      timeout: options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
      // Puppeteer's own handlers close the browser on these, which is what we
      // want — but it would leave the profile directory behind, so the
      // handlers below finish the job.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (error) {
    // A failed launch must not leave its profile behind; nothing else will
    // ever come back for it, and the caller has no handle to clean up with.
    removeProfile(profile.dir);
    throw new BrowserLaunchError(
      `could not start Chrome at ${chrome.executablePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "Check the binary runs standalone, and that no policy blocks automation of it.",
      error,
    );
  }

  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      // `close` is graceful; if Chrome is already gone or wedged, the profile
      // still has to be removed, hence the finally.
      if (browser.connected) await browser.close();
    } catch (error) {
      log.warn("browser did not close cleanly", {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        await rm(profile.dir, { recursive: true, force: true });
      } catch (error) {
        log.warn("could not remove browser profile", {
          dir: profile.dir,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      detachSignalHandlers();
    }
  };

  // Chrome dying on its own — a crash, an external kill, an OOM — must not
  // leave a profile behind or a session that lies about being open.
  browser.once("disconnected", () => {
    if (closed) return;
    closed = true;
    removeProfile(profile.dir);
    detachSignalHandlers();
    log.warn("browser disconnected unexpectedly", { sessionId: options.sessionId });
  });

  const onSignal = (): void => {
    // Synchronous, because the process is on its way out and an awaited
    // cleanup would not finish. Chrome is killed rather than closed for the
    // same reason.
    closed = true;
    try {
      browser.process()?.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    removeProfile(profile.dir);
  };

  const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  function detachSignalHandlers(): void {
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
    process.removeListener("exit", onSignal);
  }
  for (const signal of SIGNALS) process.once(signal, onSignal);
  process.once("exit", onSignal);

  log.info("browser started", {
    sessionId: options.sessionId,
    executablePath: chrome.executablePath,
    headless,
    profileDir: profile.dir,
  });

  return {
    browser,
    profileDir: profile.dir,
    executablePath: chrome.executablePath,
    sessionId: options.sessionId,
    get closed() {
      return closed;
    },
    close: cleanup,
  };
}

/**
 * Run something against a browser and always shut it down.
 *
 * The form callers should reach for. A leaked browser holds a Chrome process
 * and a profile directory, and the symptom — a test run that never exits, or a
 * disk slowly filling — points nowhere near the code that forgot to close.
 */
export async function withBrowser<T>(
  options: LaunchOptions,
  body: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const session = await launchBrowser(options);
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}
