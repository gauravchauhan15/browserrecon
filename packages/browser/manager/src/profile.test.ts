import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProfile, removeProfile, sweepOrphanProfiles } from "./profile.js";

const root = (): string => mkdtempSync(join(tmpdir(), "br-profile-root-"));

/** A profile directory as some other process would have left it. */
function plant(dir: string, name: string, owner: unknown): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  if (owner !== undefined) {
    writeFileSync(join(path, ".browserrecon-owner.json"), JSON.stringify(owner), "utf8");
  }
  return path;
}

/** A pid that is certainly not running. */
const DEAD_PID = 2 ** 22 - 1;

describe("creating a profile", () => {
  it("gives every scan its own directory", async () => {
    // §22.3: never share browser state between scans. A scan logs in and
    // collects the target's cookies and tokens; carrying those into the next
    // scan would visit a second target with the first one's credentials.
    const dir = root();
    const a = createProfile("sess_0001", dir);
    const b = createProfile("sess_0002", dir);

    expect(a.dir).not.toBe(b.dir);
    expect(existsSync(a.dir)).toBe(true);
    expect(existsSync(b.dir)).toBe(true);
  });

  it("records which process owns it", async () => {
    const profile = createProfile("sess_0007", root());
    const owner = JSON.parse(
      readFileSync(join(profile.dir, ".browserrecon-owner.json"), "utf8"),
    ) as { pid: number; sessionId: string };

    expect(owner.pid).toBe(process.pid);
    expect(owner.sessionId).toBe("sess_0007");
  });
});

describe("removing a profile", () => {
  it("removes the directory and everything in it", async () => {
    const profile = createProfile("sess_0001", root());
    writeFileSync(join(profile.dir, "Cookies"), "not really a cookie jar", "utf8");

    expect(removeProfile(profile.dir)).toBe(true);
    expect(existsSync(profile.dir)).toBe(false);
  });

  it("never throws, because it runs while something else is already failing", async () => {
    // Teardown often runs with an in-flight error. Turning "the scan crashed"
    // into "cleanup also crashed" loses the error worth reading.
    expect(() => removeProfile("/nonexistent/path/that/cannot/be/removed")).not.toThrow();
  });

  it("is safe to call twice", async () => {
    const profile = createProfile("sess_0001", root());
    removeProfile(profile.dir);
    expect(removeProfile(profile.dir)).toBe(true);
  });
});

describe("sweeping orphans", () => {
  it("removes a profile whose owning process is gone", async () => {
    // The case a running process cannot handle: SIGKILL, or the machine
    // losing power, leaves the directory behind.
    const dir = root();
    const orphan = plant(dir, "browserrecon-profile-abc123", {
      pid: DEAD_PID,
      sessionId: "sess_0001",
      createdAt: "2026-09-11T00:00:00.000Z",
    });

    const result = sweepOrphanProfiles(dir);
    expect(result.removed).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
  });

  it("leaves a profile whose owner is still running", async () => {
    // The reason the check is "is that pid alive" rather than "is it old": an
    // age heuristic reaps a long scan's live profile or leaves a dead one for
    // hours, depending on which way it is tuned.
    const dir = root();
    const mine = createProfile("sess_0001", dir);

    const result = sweepOrphanProfiles(dir);
    expect(result.removed).toEqual([]);
    expect(result.live).toEqual([mine.dir]);
    expect(existsSync(mine.dir)).toBe(true);
  });

  it("ignores directories it did not create", async () => {
    // This deletes recursively under the system temp directory, so it has to
    // be paranoid about what it matches.
    const dir = root();
    const notOurs = plant(dir, "someone-elses-data", { pid: DEAD_PID });
    const unmarked = plant(dir, "browserrecon-profile-unmarked", undefined);

    const result = sweepOrphanProfiles(dir);
    expect(result.removed).toEqual([]);
    expect(existsSync(notOurs)).toBe(true);
    expect(existsSync(unmarked)).toBe(true);
  });

  it("leaves a profile whose marker cannot be read", async () => {
    // A marker we cannot parse is one we cannot reason about. Leaving it costs
    // a directory; removing it risks deleting something live.
    const dir = root();
    const path = join(dir, "browserrecon-profile-corrupt");
    mkdirSync(path);
    writeFileSync(join(path, ".browserrecon-owner.json"), "{ not json", "utf8");

    expect(sweepOrphanProfiles(dir).removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it("copes with a root that does not exist", async () => {
    expect(sweepOrphanProfiles("/no/such/root")).toEqual({ removed: [], live: [] });
  });

  it("separates the living from the dead in one pass", async () => {
    const dir = root();
    const mine = createProfile("sess_0001", dir);
    const orphan = plant(dir, "browserrecon-profile-dead", { pid: DEAD_PID });

    const result = sweepOrphanProfiles(dir);
    expect(result.removed).toEqual([orphan]);
    expect(result.live).toEqual([mine.dir]);
  });
});
