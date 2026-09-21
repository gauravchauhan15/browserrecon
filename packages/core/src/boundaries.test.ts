import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOUNDARY_RULES,
  OUTPUT_BOUNDARIES,
  OUTPUT_DIR_MODE,
  UNREDACTED_OUTPUT_WARNING,
  createSecureOutputDir,
  mayOptOut,
  requiresRedaction,
  type OutputBoundary,
} from "./boundaries.js";

describe("the boundary table", () => {
  it("has a rule for every boundary, and no rule for anything else", () => {
    // Drift in either direction is a hole: a boundary with no rule falls
    // through to a default nobody chose, and a rule with no boundary is a
    // decision that stopped being enforced.
    expect(BOUNDARY_RULES.map((rule) => rule.boundary).sort()).toEqual(
      [...OUTPUT_BOUNDARIES].sort(),
    );
  });

  it("explains every rule", () => {
    for (const rule of BOUNDARY_RULES) {
      expect(rule.why.length, rule.boundary).toBeGreaterThan(20);
    }
  });

  it("does NOT redact the event store", () => {
    // The load-bearing entry. §22.1 writes raw observations by design: a
    // redacted Authorization header cannot be matched to the session that
    // produced it. If this ever flips, correlation silently gets worse while
    // every test still passes — so it is asserted directly.
    expect(requiresRedaction("event_store")).toBe(false);
  });

  it("redacts every other boundary", () => {
    for (const boundary of OUTPUT_BOUNDARIES) {
      if (boundary === "event_store") continue;
      expect(requiresRedaction(boundary), boundary).toBe(true);
    }
  });

  it("allows an opt-out only for the JSON export", () => {
    // §37.2: one deliberate escape hatch, for a user feeding their own
    // pipeline. Everything else is unconditional.
    const optOut = BOUNDARY_RULES.filter((rule) => rule.optOutAllowed).map((r) => r.boundary);
    expect(optOut).toEqual(["attack_surface_json"]);
  });

  it("never lets a remote sink opt out", () => {
    // §38 promises no telemetry, so this sink does not exist. The rule is
    // here so that adding one cannot arrive without the decision already
    // made against it.
    expect(requiresRedaction("remote_sink")).toBe(true);
    expect(mayOptOut("remote_sink")).toBe(false);
  });

  it("fails closed for a boundary nobody wrote a rule for", () => {
    // A new output added without a rule must be redacted and must not be
    // opt-outable. Defaulting a security question to permissive is how the
    // decision gets made by accident.
    const unknown = "some_future_sink" as OutputBoundary;
    expect(requiresRedaction(unknown)).toBe(true);
    expect(mayOptOut(unknown)).toBe(false);
  });
});

describe("the output directory", () => {
  const originalUmask = process.umask();
  afterEach(() => {
    process.umask(originalUmask);
  });

  it("is owner-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "br-out-")), "output");
    createSecureOutputDir(path);
    expect(statSync(path).mode & 0o777).toBe(OUTPUT_DIR_MODE);
  });

  it("tightens a directory that already exists", () => {
    // The probe that justifies the chmod, and the case that actually
    // happens. `mkdir(mode)` is masked by the umask, so it can only ever be
    // stricter than 0700 — but with `recursive: true` it does nothing at all
    // to an existing directory. A `.output/` left by an earlier version, or
    // made by hand with `mkdir -p`, keeps its 0755 and every cookie in it is
    // readable by anyone on the machine.
    process.umask(0o000);
    const path = join(mkdtempSync(join(tmpdir(), "br-out-")), "output");
    mkdirSync(path, { mode: 0o755 });
    expect(statSync(path).mode & 0o777, "precondition: the directory is loose").toBe(0o755);

    createSecureOutputDir(path);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(OUTPUT_DIR_MODE);
    expect(mode & 0o077, "group or other can read .output/").toBe(0);
  });

  it("does not depend on the umask to be strict", () => {
    process.umask(0o000);
    const path = join(mkdtempSync(join(tmpdir(), "br-out-")), "output");
    createSecureOutputDir(path);
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("is idempotent, so a resumed scan does not fail on an existing directory", () => {
    const path = join(mkdtempSync(join(tmpdir(), "br-out-")), "a", "b");
    createSecureOutputDir(path);
    expect(() => createSecureOutputDir(path)).not.toThrow();
    expect(statSync(path).mode & 0o777).toBe(OUTPUT_DIR_MODE);
  });
});

describe("the warning", () => {
  it("names what is actually in there", () => {
    // "may contain sensitive data" is ignorable. Naming cookies and tokens
    // is what makes someone not paste the directory into a ticket.
    for (const term of ["cookies", "tokens", "authorization", "UNREDACTED"]) {
      expect(UNREDACTED_OUTPUT_WARNING).toContain(term);
    }
  });

  it("says what not to do with it", () => {
    expect(UNREDACTED_OUTPUT_WARNING).toMatch(/do not commit/i);
  });
});
