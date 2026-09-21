import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT } from "@browserrecon/event-store";
import {
  SESSION_FILE_VERSION,
  digestPolicy,
  type SessionFile,
} from "@browserrecon/orchestrator";
import { describe, expect, it } from "vitest";
import { EXIT_CODES, type CliError } from "../exit-codes.js";
import { policySummaryFor, resolveSessionDir, resume } from "./resume.js";
import { resolveTargetPolicy } from "@browserrecon/policy";

/**
 * The §30 gate, end to end through the command.
 *
 * `decideResume` is unit-tested in the orchestrator; what these cover is
 * the wiring, which is where a refusal gets lost. A gate that is correct
 * and never called is the same as no gate.
 */

/**
 * Derived exactly as the scan would derive it.
 *
 * Hand-writing the summary here would test a fixture rather than the
 * system: the first version of this file spelled out the defaults, got
 * `excludedPaths` wrong, and reported a refusal that the real code would
 * never produce.
 */
function defaultPolicySummary(): Record<string, string> {
  const resolved = resolveTargetPolicy({
    targetOrigin: "https://shop.example.com",
    config: {},
  });
  if (!resolved.ok) throw new Error("the default policy should resolve");
  return policySummaryFor(resolved.policy, "");
}

const DEFAULT_POLICY: Readonly<Record<string, string>> = defaultPolicySummary();

function sessionDir(overrides: Partial<SessionFile> = {}, policy = DEFAULT_POLICY): string {
  const dir = mkdtempSync(join(tmpdir(), "br-resume-cli-"));
  const session: SessionFile = {
    version: SESSION_FILE_VERSION,
    sessionId: "sess_0001",
    target: "https://shop.example.com",
    tool: { name: "browserrecon", version: "0.1.0" },
    policyDigest: digestPolicy(policy),
    policySummary: policy,
    authorization: { asserted: true },
    phases: [],
    completeness: "partial",
    stopReason: "max_pages",
    segments: [
      {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        firstSequence: 1,
        lastSequence: 812,
      },
    ],
    budgetExtensions: [],
    ...overrides,
  };
  writeFileSync(join(dir, LAYOUT.session), `${JSON.stringify(session, null, 2)}\n`);
  return dir;
}

function invoke(dir: string, flags: Record<string, unknown> = {}, argv: string[] = []) {
  const out: string[] = [];
  try {
    resume({
      session: dir,
      parsed: flags,
      argv,
      env: {},
      write: (line) => out.push(line),
    });
    return { out: out.join("\n"), error: undefined };
  } catch (caught) {
    return { out: out.join("\n"), error: caught as CliError };
  }
}

describe("finding the session", () => {
  it("accepts a directory", () => {
    const { error } = invoke(sessionDir());
    expect(error?.message).toContain("pre-release");
  });

  it("resolves a bare session id under the output directory", () => {
    expect(resolveSessionDir("sess_0001", ".output")).toBe(".output/sess_0001");
    expect(resolveSessionDir("/tmp/somewhere", ".output")).toBe("/tmp/somewhere");
    expect(resolveSessionDir("./local/dir", ".output")).toBe("./local/dir");
  });

  it("says where it looked when there is no session", () => {
    const { error } = invoke(mkdtempSync(join(tmpdir(), "br-empty-")));
    expect(error?.code).toBe(EXIT_CODES.configuration);
    expect(error?.hint).toContain("session.json");
  });

  it("does not suggest deleting a session it cannot parse", () => {
    // The directory holds the event log, which is the evidence. A broken
    // session.json is recoverable; a deleted log is not.
    const dir = mkdtempSync(join(tmpdir(), "br-broken-"));
    writeFileSync(join(dir, LAYOUT.session), "{ not json");
    const { error } = invoke(dir);

    expect(error?.code).toBe(EXIT_CODES.configuration);
    expect(error?.hint).not.toMatch(/delete|remove|rm /i);
    expect(error?.hint).toContain("unaffected");
  });
});

describe("the §30 gate", () => {
  it("refuses a changed origin with the policy exit code", () => {
    // Code 5, not 3: the settings are individually valid and the scan is
    // being refused on scope grounds, which is what a pipeline branches on.
    const { error } = invoke(sessionDir(), { allowedOrigins: ["https://other.example.com"] }, [
      "--allowed-origins",
      "https://other.example.com",
    ]);
    expect(error?.code).toBe(EXIT_CODES.policy);
    expect(error?.message).toContain("--seed-from sess_0001");
  });

  it("refuses a changed method set", () => {
    const { error } = invoke(
      sessionDir(),
      { allowedMethods: ["GET", "HEAD", "OPTIONS", "POST"] },
      ["--allowed-methods", "GET,HEAD,OPTIONS,POST"],
    );
    expect(error?.code).toBe(EXIT_CODES.policy);
    expect(error?.message).toContain("allowedMethods");
  });

  it("allows an unchanged resume through to the engine", () => {
    const { error } = invoke(sessionDir());
    expect(error?.code).toBe(EXIT_CODES.usage);
    expect(error?.message).toContain("pre-release");
  });

  it("reports what the previous run managed", () => {
    const { out } = invoke(sessionDir());
    expect(out).toContain("sess_0001");
    expect(out).toContain("partial (max_pages)");
    expect(out).toContain("sequence 812");
  });

  it("never reads the target from a flag", () => {
    // Taking the target from anywhere but the session is how the boundary
    // would change without the digest noticing.
    const { error } = invoke(sessionDir(), { target: "https://elsewhere.example.com" }, [
      "--target",
      "https://elsewhere.example.com",
    ]);
    expect(error?.code).not.toBe(EXIT_CODES.policy);
  });
});

describe("budget changes", () => {
  it("reports a raise as an extension", () => {
    const policy = { ...DEFAULT_POLICY, maxPages: "100" };
    const { out } = invoke(sessionDir({}, policy), { maxPages: 500 }, ["--max-pages", "500"]);
    expect(out).toContain("Budget extended");
    expect(out).toContain("100 -> 500");
  });

  it("does not refuse a raise", () => {
    const { error } = invoke(sessionDir(), { maxPages: 5000 }, ["--max-pages", "5000"]);
    expect(error?.code).not.toBe(EXIT_CODES.policy);
  });
});
