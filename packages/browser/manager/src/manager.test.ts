/// <reference lib="dom" />
//
// The DOM lib is pulled in for this file alone, not for the whole test
// project. Code inside `page.evaluate` runs in the browser and legitimately
// touches `document` and `localStorage`; adding those globals project-wide
// would let a Node-context test reference `window` and still type-check.
// Caught by the test type-check gate, which is what it is for.

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixture, staticSite, type RunningFixture } from "@browserrecon/fixtures";
import { BrowserLaunchError, launchBrowser, withBrowser } from "./manager.js";
import { resolveChromePath, type ChromeProbes } from "./chrome-path.js";
import { createProfile } from "./profile.js";

/**
 * These tests drive a real Chrome. That is the point — every acceptance
 * criterion for this story is about what actually happens to a process and a
 * directory, and none of it can be proven against a mock.
 */

const systemProbes: ChromeProbes = {
  fileExists: (path) => existsSync(path),
  runCommand: (command, args) => {
    const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 5_000 });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  },
  platform: platform(),
  env: {},
};

const chrome = resolveChromePath(systemProbes);

/**
 * Skipping is allowed on a developer's machine, never in CI.
 *
 * A browser test that quietly skips is worse than one that fails: the suite
 * stays green while the only tests covering process and profile lifetime never
 * run. The guard below makes that impossible to do accidentally in automation.
 */
const CI = process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false";
const canLaunch = chrome.found;
const browserTest = canLaunch ? it : it.skip;

const root = (): string => mkdtempSync(join(tmpdir(), "br-mgr-"));

/** Launch options with detection already done, for brevity in each test. */
const options = (sessionId: string, profileRoot: string) => ({
  sessionId,
  probes: systemProbes,
  profileRoot,
  // Off by default here: these tests plant profiles and assert on their
  // survival, and a sweep would remove the evidence.
  sweepOrphans: false,
});

describe("preconditions", () => {
  it("has a Chrome to drive, which is mandatory in CI", () => {
    if (CI) {
      expect(
        chrome.found,
        `no Chrome found in CI: ${chrome.found === false ? chrome.reason : ""}. ` +
          "These tests cover process and profile lifetime and must not be skipped in automation.",
      ).toBe(true);
      return;
    }
    if (!chrome.found) {
      console.warn(`\n  [browser tests skipped] ${chrome.reason}\n  ${chrome.remedy}\n`);
    }
    expect(true).toBe(true);
  });
});

describe("profile lifetime", () => {
  browserTest(
    "creates a profile directory and removes it on close",
    async () => {
      const dir = root();
      const session = await launchBrowser(options("sess_0001", dir));

      expect(existsSync(session.profileDir)).toBe(true);
      expect(session.profileDir.startsWith(dir)).toBe(true);
      // Chrome actually used it, rather than the directory merely existing.
      expect(readdirSync(session.profileDir).length).toBeGreaterThan(1);

      await session.close();
      expect(existsSync(session.profileDir)).toBe(false);
      expect(session.closed).toBe(true);
    },
    60_000,
  );

  browserTest(
    "gives two sequential scans different profiles",
    async () => {
      const dir = root();
      const first = await launchBrowser(options("sess_0001", dir));
      const firstDir = first.profileDir;
      await first.close();

      const second = await launchBrowser(options("sess_0002", dir));
      expect(second.profileDir).not.toBe(firstDir);
      await second.close();
    },
    60_000,
  );

  browserTest(
    "removes the profile even when the caller throws",
    async () => {
      const dir = root();
      let profileDir = "";

      await expect(
        withBrowser(options("sess_0001", dir), async (session) => {
          profileDir = session.profileDir;
          throw new Error("scan blew up");
        }),
      ).rejects.toThrow("scan blew up");

      // The original error survives, and the profile does not.
      expect(existsSync(profileDir)).toBe(false);
    },
    60_000,
  );

  browserTest(
    "is safe to close twice",
    async () => {
      const session = await launchBrowser(options("sess_0001", root()));
      await session.close();
      await expect(session.close()).resolves.toBeUndefined();
    },
    60_000,
  );
});

describe("isolation between scans", () => {
  let fixture: RunningFixture | undefined;

  beforeAll(async () => {
    if (!canLaunch) return;
    fixture = await startFixture(staticSite());
  });

  afterAll(async () => {
    await fixture?.close();
  });

  browserTest(
    "carries no cookie or local storage from one scan into the next",
    async () => {
      // §22.3, and the reason it matters here rather than as hygiene: a scan
      // authenticates and collects the target's session cookies. If those
      // survived, the next scan would visit its target carrying the previous
      // one's credentials, and every observation would be attributed to an
      // auth context nobody declared (§12.3).
      //
      // Both scans use the same fixture origin deliberately. Cookies ignore
      // the port, but local storage does not, so a different port would make
      // half of this pass for the wrong reason.
      const origin = fixture?.origin ?? "";
      const dir = root();

      await withBrowser(options("sess_0001", dir), async (session) => {
        const page = await session.browser.newPage();
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => {
          document.cookie = "session_token=secret-from-scan-a; path=/";
          localStorage.setItem("api_key", "leaked-from-scan-a");
          sessionStorage.setItem("scan", "a");
        });

        // Prove the write landed, or the second half proves nothing.
        const stored = await page.evaluate(() => localStorage.getItem("api_key"));
        expect(stored).toBe("leaked-from-scan-a");
      });

      await withBrowser(options("sess_0002", dir), async (session) => {
        const page = await session.browser.newPage();
        await page.goto(origin, { waitUntil: "domcontentloaded" });

        const state = await page.evaluate(() => ({
          cookie: document.cookie,
          apiKey: localStorage.getItem("api_key"),
          scan: sessionStorage.getItem("scan"),
        }));

        expect(state.cookie).not.toContain("secret-from-scan-a");
        expect(state.apiKey).toBeNull();
        expect(state.scan).toBeNull();
      });
    },
    90_000,
  );

  browserTest(
    "loads a page without it requesting anything off-origin",
    async () => {
      // Scoped deliberately, and named for what it actually proves.
      //
      // The first version of this test claimed to show that Chrome reaches
      // nothing but the target. It does not: `page.on("request")` sees only
      // what that page requests. Chrome's background traffic — component
      // updates, Safe Browsing, field trials — belongs to no page and is
      // invisible here. Probed by stripping every egress flag from
      // flags.ts: this test stayed green while the flag tests failed, which
      // is exactly the false confidence a well-named test can create.
      //
      // So browser-level egress is guarded by the flag list (flags.test.ts),
      // not by observation. It becomes observable in BR-M1-03, where the
      // telemetry adapter subscribes to CDP at the browser level and every
      // request Chrome makes is in the event stream by construction.
      //
      // What this test does prove is still worth having: a page in a freshly
      // launched profile pulls in nothing external of its own — no extension
      // fetch, no profile-carried resource.
      const origin = fixture?.origin ?? "";
      const external: string[] = [];

      await withBrowser(options("sess_0001", root()), async (session) => {
        const page = await session.browser.newPage();
        page.on("request", (request) => {
          const url = request.url();
          if (url.startsWith(origin) || url.startsWith("data:") || url === "about:blank")
            return;
          external.push(url);
        });
        await page.goto(origin, { waitUntil: "networkidle2" });
      });

      expect(external, `browser reached: ${external.join(", ")}`).toEqual([]);
    },
    90_000,
  );
});

describe("failure paths", () => {
  browserTest(
    "cleans up when Chrome is killed underneath us",
    async () => {
      // The crash case. Chrome dying on its own must not leave a profile
      // behind, must not leave the session claiming to be open, and must not
      // make a later close() hang.
      const session = await launchBrowser(options("sess_0001", root()));
      const child = session.browser.process();
      expect(child?.pid).toBeGreaterThan(0);

      const exited = new Promise<void>((resolve) => {
        session.browser.once("disconnected", () => resolve());
      });
      child?.kill("SIGKILL");
      await exited;

      expect(session.closed).toBe(true);
      expect(existsSync(session.profileDir)).toBe(false);
      await expect(session.close()).resolves.toBeUndefined();

      // "No orphaned Chrome process" means no Chrome still *running* against
      // this profile — including the renderer and GPU helpers, which a check
      // on the browser pid alone would miss. The profile directory is gone by
      // now, but a surviving process still carries it in its command line.
      expect(await waitForNoProcessesUsing(session.profileDir)).toEqual([]);

      // Not `process.kill(pid, 0)`. A just-killed child is a zombie until Node
      // reaps it, and signal 0 reports a zombie as alive — measured here: the
      // state right after `disconnected` is "Z <defunct>", and the pid is gone
      // half a second later. Asserting "alive" would have failed while nothing
      // was actually running.
      expect(runState(child?.pid ?? 0)).toMatch(/^$|^Z/);
    },
    60_000,
  );

  it("reports a missing binary as a fixable error, leaving no profile", async () => {
    // No browser needed: this is the path where launch never happens.
    const dir = root();
    await expect(
      launchBrowser({
        sessionId: "sess_0001",
        probes: systemProbes,
        profileRoot: dir,
        executablePath: "/nonexistent/chrome",
        sweepOrphans: false,
      }),
    ).rejects.toThrow(BrowserLaunchError);

    expect(readdirSync(dir)).toEqual([]);
  });

  browserTest(
    "leaves no profile behind when the binary exists but will not start",
    async () => {
      // A real file that is not a browser: detection succeeds, launch fails.
      // The profile is created before the launch attempt, so this is the path
      // that would leak a directory nobody ever comes back for.
      const dir = root();
      const notABrowser = process.execPath;

      await expect(
        launchBrowser({
          sessionId: "sess_0001",
          probes: systemProbes,
          profileRoot: dir,
          executablePath: notABrowser,
          launchTimeoutMs: 5_000,
          sweepOrphans: false,
        }),
      ).rejects.toThrow(BrowserLaunchError);

      expect(readdirSync(dir)).toEqual([]);
    },
    30_000,
  );
});

describe("orphan sweeping at launch", () => {
  browserTest(
    "removes a profile left by a process that is gone",
    async () => {
      const dir = root();
      const orphan = createProfile("sess_0000", dir);
      // Rewrite the marker to a pid that cannot be running.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(orphan.dir, ".browserrecon-owner.json"),
        JSON.stringify({ pid: 2 ** 22 - 1, sessionId: "sess_0000", createdAt: "" }),
        "utf8",
      );

      const session = await launchBrowser({
        sessionId: "sess_0001",
        probes: systemProbes,
        profileRoot: dir,
        sweepOrphans: true,
      });

      expect(existsSync(orphan.dir)).toBe(false);
      await session.close();
    },
    60_000,
  );
});

/** A process's state letter, or "" if there is no such process. `Z` is a zombie. */
function runState(pid: number): string {
  if (pid === 0) return "";
  const result = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return (result.stdout ?? "").trim();
}

/**
 * Wait for every process using this profile to go away, up to a limit.
 *
 * Killing the browser process does not synchronously reap its renderer and
 * GPU helpers — the OS tears them down a moment later. Asserting in the same
 * tick made this test pass alone and fail under the full suite, where the
 * machine is busy enough for the gap to matter. What the test means is "no
 * orphan survives", not "no orphan exists in this microsecond", so it waits.
 */
async function waitForNoProcessesUsing(
  profileDir: string,
  limitMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + limitMs;
  let remaining = processesUsing(profileDir);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = processesUsing(profileDir);
  }
  return remaining;
}

/** Pids of any process whose command line mentions this profile directory. */
function processesUsing(profileDir: string): string[] {
  const result = spawnSync("pgrep", ["-f", profileDir], { encoding: "utf8" });
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
