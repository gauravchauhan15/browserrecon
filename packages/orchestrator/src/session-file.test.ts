import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMMUTABLE_FOR_RESUME,
  SESSION_FILE_VERSION,
  digestPolicy,
  parseSessionFile,
  writeSessionFile,
  type SessionFile,
} from "./session-file.js";

const POLICY: Readonly<Record<string, string>> = {
  target: "https://shop.example.com",
  allowedOrigins: "https://shop.example.com",
  allowedMethods: "GET,HEAD,OPTIONS",
  excludedPaths: "/logout,/admin",
  authProfile: "",
  denyLoopback: "true",
  denyPrivateRanges: "true",
  followExternalRedirects: "false",
};

function session(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    version: SESSION_FILE_VERSION,
    sessionId: "sess_0001",
    target: "https://shop.example.com",
    tool: { name: "browserrecon", version: "0.1.0" },
    policyDigest: digestPolicy(POLICY),
    policySummary: POLICY,
    authorization: { asserted: true, method: "interactive" },
    phases: [],
    completeness: "complete",
    segments: [{ startedAt: "2026-01-15T10:00:00.000Z", firstSequence: 1, lastSequence: 420 }],
    budgetExtensions: [],
    ...overrides,
  };
}

describe("the policy digest", () => {
  it("is stable for the same policy", () => {
    expect(digestPolicy(POLICY)).toBe(digestPolicy({ ...POLICY }));
  });

  it("changes when any immutable setting changes", () => {
    // Every one of these decides what the scan was allowed to touch.
    // Missing one means a resume can silently widen the boundary and the
    // coverage report describes something that never happened.
    for (const key of IMMUTABLE_FOR_RESUME) {
      const changed = { ...POLICY, [key]: `${POLICY[key] ?? ""}-changed` };
      expect(digestPolicy(changed), `${key} does not affect the digest`).not.toBe(
        digestPolicy(POLICY),
      );
    }
  });

  it("ignores the order a list was written in", () => {
    // A spurious refusal teaches users to reach for --seed-from when they
    // did not need it, which costs them the continuity they wanted.
    expect(digestPolicy({ ...POLICY, allowedMethods: "OPTIONS,GET,HEAD" })).toBe(
      digestPolicy(POLICY),
    );
    expect(digestPolicy({ ...POLICY, allowedMethods: "GET, HEAD , OPTIONS" })).toBe(
      digestPolicy(POLICY),
    );
  });

  it("does not change when a budget setting changes", () => {
    // §30 allows budget and thoroughness to be raised on resume, so they
    // must not be in the digest — otherwise the allowed case is refused.
    expect(digestPolicy({ ...POLICY, maxPages: "5000", thoroughness: "deep" })).toBe(
      digestPolicy(POLICY),
    );
  });

  it("treats a missing setting as empty rather than throwing", () => {
    expect(() => digestPolicy({})).not.toThrow();
    expect(digestPolicy({})).not.toBe(digestPolicy(POLICY));
  });
});

describe("writing", () => {
  it("writes owner-only", () => {
    // The file carries the target, the auth profile name and the
    // authorization record.
    const path = join(mkdtempSync(join(tmpdir(), "br-sess-")), "session.json");
    writeSessionFile(path, session());
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("round-trips", () => {
    const path = join(mkdtempSync(join(tmpdir(), "br-sess-")), "session.json");
    writeSessionFile(path, session());
    expect(parseSessionFile(readFileSync(path, "utf8"))).toEqual(session());
  });

  it("leaves no partial file behind for a reader to trip on", () => {
    // Written through a rename because the writer is a process that may be
    // killed at any moment — which is the only reason `resume` exists.
    const dir = mkdtempSync(join(tmpdir(), "br-sess-"));
    const path = join(dir, "session.json");
    writeSessionFile(path, session());
    writeSessionFile(path, session({ completeness: "partial" }));

    const parsed = parseSessionFile(readFileSync(path, "utf8"));
    expect("error" in parsed).toBe(false);
    expect((parsed as SessionFile).completeness).toBe("partial");
  });
});

describe("parsing", () => {
  it("reports a problem instead of throwing", () => {
    for (const text of ["", "{", "null", "[]", '"a string"', "42"]) {
      const parsed = parseSessionFile(text);
      expect("error" in parsed, `accepted ${JSON.stringify(text)}`).toBe(true);
    }
  });

  it("refuses a version it does not understand", () => {
    // A future session directory read by an older binary is a real case,
    // and guessing at the shape is how a resume corrupts a log.
    const text = JSON.stringify({ ...session(), version: 2 });
    expect(parseSessionFile(text)).toEqual({
      error: "session.json has version 2, expected 1",
    });
  });

  it("refuses a file missing the fields resume depends on", () => {
    const { policyDigest: _omitted, ...rest } = session();
    const parsed = parseSessionFile(JSON.stringify(rest));
    expect("error" in parsed).toBe(true);
  });

  it("reads a file written by a real run", () => {
    const path = join(mkdtempSync(join(tmpdir(), "br-sess-")), "session.json");
    writeFileSync(path, `${JSON.stringify(session(), null, 2)}\n`);
    expect("error" in parseSessionFile(readFileSync(path, "utf8"))).toBe(false);
  });
});
