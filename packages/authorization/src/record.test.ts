import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRecord,
  defaultRecordPath,
  readRecord,
  withConfirmedTarget,
  writeRecord,
} from "./record.js";

const TARGET = "https://shop.example.com";
const temp = (): string => join(mkdtempSync(join(tmpdir(), "br-auth-")), "authorization.json");

describe("defaultRecordPath", () => {
  it("respects XDG_CONFIG_HOME above everything else", () => {
    expect(defaultRecordPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u", "linux")).toBe(
      "/xdg/browserrecon/authorization.json",
    );
  });

  it("uses the platform convention rather than a dotfile in $HOME", () => {
    expect(defaultRecordPath({}, "/Users/u", "darwin")).toBe(
      "/Users/u/Library/Application Support/browserrecon/authorization.json",
    );
    expect(defaultRecordPath({}, "/home/u", "linux")).toBe(
      "/home/u/.config/browserrecon/authorization.json",
    );
    expect(defaultRecordPath({ APPDATA: "C:\\AppData" }, "C:\\Users\\u", "win32")).toContain(
      "browserrecon",
    );
  });

  it("ignores an empty XDG_CONFIG_HOME", () => {
    // Unset variables often materialize as "" in CI.
    expect(defaultRecordPath({ XDG_CONFIG_HOME: "" }, "/home/u", "linux")).toBe(
      "/home/u/.config/browserrecon/authorization.json",
    );
  });
});

describe("round trip", () => {
  it("writes and reads a record", () => {
    const path = temp();
    const record = createRecord("interactive", TARGET, () => new Date("2026-09-10T12:00:00Z"));
    writeRecord(path, record);

    expect(readRecord(path)).toEqual({
      version: 1,
      acknowledgedAt: "2026-09-10T12:00:00.000Z",
      acknowledgedVia: "interactive",
      confirmedTargets: [TARGET],
    });
  });

  it("writes the file owner-only", () => {
    // Not a secret, but it records an assertion about the user's authority;
    // other local accounts have no business reading or editing it.
    const path = temp();
    writeRecord(path, createRecord("flag", TARGET));
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

describe("fail closed", () => {
  it("returns undefined for a missing file", () => {
    expect(
      readRecord(join(tmpdir(), "definitely-not-here", "authorization.json")),
    ).toBeUndefined();
  });

  it("returns undefined for anything malformed", () => {
    // A corrupt file must never be interpreted as consent. Each of these
    // resolves to "not acknowledged", which forces the gate to ask again.
    for (const contents of [
      "",
      "not json",
      "null",
      "[]",
      '"a string"',
      "{}",
      JSON.stringify({ version: 2, acknowledgedAt: "x", acknowledgedVia: "flag" }),
      JSON.stringify({ version: 1, acknowledgedVia: "flag" }),
      JSON.stringify({ version: 1, acknowledgedAt: "x", acknowledgedVia: "telepathy" }),
    ]) {
      const path = temp();
      writeFileSync(path, contents);
      expect(readRecord(path), JSON.stringify(contents)).toBeUndefined();
    }
  });

  it("tolerates a junk entry in confirmedTargets without discarding the record", () => {
    // Partial corruption of the target list is recoverable — drop the junk,
    // keep the acknowledgment. Losing it entirely would re-prompt for no
    // security gain.
    const path = temp();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        acknowledgedAt: "2026-09-10T12:00:00.000Z",
        acknowledgedVia: "flag",
        confirmedTargets: [TARGET, 42, null],
      }),
    );
    expect(readRecord(path)?.confirmedTargets).toEqual([TARGET]);
  });
});

describe("withConfirmedTarget", () => {
  it("appends without mutating the original", () => {
    const original = createRecord("interactive", TARGET);
    const updated = withConfirmedTarget(original, "https://other.example.com");

    expect(updated.confirmedTargets).toEqual([TARGET, "https://other.example.com"]);
    expect(original.confirmedTargets).toEqual([TARGET]);
  });

  it("does not duplicate an existing target", () => {
    const original = createRecord("interactive", TARGET);
    expect(withConfirmedTarget(original, TARGET)).toBe(original);
  });

  it("survives a write/read cycle after being updated", () => {
    const path = temp();
    writeRecord(
      path,
      withConfirmedTarget(createRecord("flag", TARGET), "https://b.example.com"),
    );
    expect(readRecord(path)?.confirmedTargets).toHaveLength(2);
  });
});

describe("stored file shape", () => {
  it("is human-readable, since a user may want to inspect or revoke it", () => {
    const path = temp();
    writeRecord(path, createRecord("interactive", TARGET));
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("\n  ");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
