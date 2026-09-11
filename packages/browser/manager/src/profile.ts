/**
 * Per-scan browser profiles — build plan §22.3, dev plan BR-M1-01.
 *
 * §22.3 is one line and it is the whole of this file: *never share browser
 * state between scans by default*. Every scan gets its own `--user-data-dir`,
 * and it is destroyed when the scan ends.
 *
 * That matters more here than in an ordinary automation tool. A scan logs in,
 * collects session cookies, tokens and local storage from a target the user is
 * authorized to test. If any of it survived into the next scan, the second
 * target would be visited carrying the first one's credentials — a
 * cross-target leak caused by the tool itself, and the observations would be
 * attributed to an auth context that was never declared (§12.3).
 *
 * ## Orphans
 *
 * A profile directory is removed on every exit path this process controls.
 * There is one it does not: `SIGKILL`, or a machine losing power, leaves the
 * directory behind — and, worse, can leave Chrome running.
 *
 * That cannot be handled in-process, so it is handled on the *next* run.
 * Profiles carry a marker file naming the process that owns them, and a sweep
 * at launch removes any whose owner is gone. The check is "is that pid alive",
 * not "is it old", because an age heuristic either reaps a long scan's live
 * profile or leaves a dead one lying around for hours.
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Marker file inside a profile, naming the process that owns it. */
const OWNER_FILE = ".browserrecon-owner.json";

/** Profile directories are named so a sweep can recognise its own. */
const PREFIX = "browserrecon-profile-";

interface OwnerRecord {
  readonly pid: number;
  readonly sessionId: string;
  /** Recorded for a human reading a directory that outlived its scan. */
  readonly createdAt: string;
}

export interface Profile {
  readonly dir: string;
  readonly sessionId: string;
}

/** Whether a process is still running. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without
    // delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — alive, and
    // certainly not ours to reap.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Create a fresh profile directory owned by this process. */
export function createProfile(sessionId: string, root: string = tmpdir()): Profile {
  const dir = mkdtempSync(join(root, PREFIX));
  const owner: OwnerRecord = {
    pid: process.pid,
    sessionId,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  return { dir, sessionId };
}

/**
 * Remove a profile directory.
 *
 * Never throws. This runs on teardown paths that are themselves often already
 * handling a failure, and turning "the scan crashed" into "the scan crashed
 * and then cleanup crashed" loses the original error, which is the one worth
 * reading.
 */
export function removeProfile(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface SweepResult {
  readonly removed: readonly string[];
  /** Profiles left alone because their owning process is still running. */
  readonly live: readonly string[];
}

/**
 * Remove profile directories whose owning process is gone.
 *
 * Only touches directories this tool created *and* marked — an unmarked
 * directory that happens to match the prefix is left alone. Deleting
 * recursively under the system temp directory is exactly the operation that
 * should be paranoid about what it matches.
 */
export function sweepOrphanProfiles(root: string = tmpdir()): SweepResult {
  const removed: string[] = [];
  const live: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed, live };
  }

  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(root, name);
    const marker = join(dir, OWNER_FILE);
    if (!existsSync(marker)) continue;

    let owner: OwnerRecord;
    try {
      owner = JSON.parse(readFileSync(marker, "utf8")) as OwnerRecord;
    } catch {
      // A marker we cannot read is a marker we cannot reason about. Leaving it
      // costs a directory; removing it risks deleting something live.
      continue;
    }

    if (typeof owner.pid !== "number" || isAlive(owner.pid)) {
      live.push(dir);
      continue;
    }
    if (removeProfile(dir)) removed.push(dir);
  }

  return { removed, live };
}
