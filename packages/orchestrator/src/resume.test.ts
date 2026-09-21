import { describe, expect, it } from "vitest";
import {
  IMMUTABLE_FOR_RESUME,
  SESSION_FILE_VERSION,
  STALENESS_THRESHOLD_MS,
  decideResume,
  digestPolicy,
  planResume,
  seedFrom,
  type ResumeRefused,
  type SessionFile,
} from "./index.js";

const POLICY: Readonly<Record<string, string>> = {
  target: "https://shop.example.com",
  allowedOrigins: "https://shop.example.com",
  allowedMethods: "GET,HEAD,OPTIONS",
  excludedPaths: "/logout",
  authProfile: "",
  denyLoopback: "true",
  denyPrivateRanges: "true",
  followExternalRedirects: "false",
};

const FINISHED = "2026-01-15T10:00:00.000Z";
const SOON = new Date("2026-01-15T10:05:00.000Z");

function prior(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    version: SESSION_FILE_VERSION,
    sessionId: "sess_0001",
    target: "https://shop.example.com",
    tool: { name: "browserrecon", version: "0.1.0" },
    policyDigest: digestPolicy(POLICY),
    policySummary: POLICY,
    authorization: { asserted: true },
    phases: [],
    completeness: "partial",
    stopReason: "max_pages",
    segments: [
      {
        startedAt: "2026-01-15T09:00:00.000Z",
        finishedAt: FINISHED,
        firstSequence: 1,
        lastSequence: 900,
      },
    ],
    budgetExtensions: [],
    ...overrides,
  };
}

const request = (overrides: Partial<Parameters<typeof decideResume>[0]> = {}) => ({
  prior: prior(),
  policySummary: POLICY,
  priorBudget: { maxPages: 100, maxRuntimeMinutes: 30 },
  budget: { maxPages: 100, maxRuntimeMinutes: 30 },
  now: SOON,
  ...overrides,
});

describe("resume is allowed when only the budget changed", () => {
  it("allows an unchanged resume", () => {
    const decision = decideResume(request());
    expect(decision.allowed).toBe(true);
  });

  it("allows raising the budget and records the raise", () => {
    // §30: the extension is recorded original → new, so a report can say
    // the scan was extended rather than presenting one uniform run.
    const decision = decideResume(
      request({ budget: { maxPages: 500, maxRuntimeMinutes: 60 } }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    expect(decision.extensions).toEqual([
      { at: SOON.toISOString(), field: "maxPages", from: 100, to: 500 },
      { at: SOON.toISOString(), field: "maxRuntimeMinutes", from: 30, to: 60 },
    ]);
  });

  it("warns rather than refusing when the budget is lowered below what is spent", () => {
    // Not a boundary change, so not a refusal — but a resumed scan that
    // stops immediately looks like a broken command.
    const decision = decideResume(request({ budget: { maxPages: 10, maxRuntimeMinutes: 30 } }));
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.warnings.join(" ")).toContain("stop straight away");
  });
});

describe("resume is refused when the boundary changed", () => {
  it("refuses every immutable setting", () => {
    // The safety test. Silently allowing any one of these produces a
    // coverage report describing a boundary that never existed.
    for (const key of IMMUTABLE_FOR_RESUME) {
      const decision = decideResume(
        request({ policySummary: { ...POLICY, [key]: `${POLICY[key] ?? ""}-different` } }),
      );
      expect(decision.allowed, `${key} was allowed to change`).toBe(false);
      expect((decision as ResumeRefused).changed).toContain(key);
    }
  });

  it("points at --seed-from, naming the session", () => {
    const decision = decideResume(
      request({ policySummary: { ...POLICY, allowedOrigins: "https://other.example.com" } }),
    ) as ResumeRefused;

    expect(decision.message).toContain("--seed-from sess_0001");
    expect(decision.message).toContain("allowedOrigins");
  });

  it("says what changed in before-and-after terms", () => {
    // "Policy mismatch" tells a user nothing they can act on.
    const decision = decideResume(
      request({ policySummary: { ...POLICY, allowedMethods: "GET,HEAD,OPTIONS,DELETE" } }),
    ) as ResumeRefused;

    expect(decision.message).toContain("was GET,HEAD,OPTIONS");
    expect(decision.message).toContain("now GET,HEAD,OPTIONS,DELETE");
  });

  it("explains why, not just that", () => {
    const decision = decideResume(
      request({ policySummary: { ...POLICY, authProfile: "admin" } }),
    ) as ResumeRefused;
    expect(decision.message).toMatch(/two different\s+boundaries/);
  });

  it("refuses a changed auth profile specifically", () => {
    // Half the pages seen anonymously and half as an administrator is the
    // case that makes a merged report actively misleading.
    const decision = decideResume(
      request({ policySummary: { ...POLICY, authProfile: "admin" } }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("does not refuse a reordered list", () => {
    const decision = decideResume(
      request({ policySummary: { ...POLICY, allowedMethods: "OPTIONS,HEAD,GET" } }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("staleness", () => {
  it("warns about a large gap between segments", () => {
    const decision = decideResume(
      request({ now: new Date(Date.parse(FINISHED) + STALENESS_THRESHOLD_MS + 60_000) }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.warnings.join(" ")).toContain("two different versions");
  });

  it("stays quiet about a resume a few minutes later", () => {
    const decision = decideResume(request());
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.warnings).toEqual([]);
  });

  it("warns rather than refusing", () => {
    // The user knows whether their target shipped anything; the tool does
    // not, and refusing would block a legitimate overnight resume.
    const decision = decideResume({
      ...request(),
      now: new Date(Date.parse(FINISHED) + 90 * 24 * 60 * 60 * 1000),
    });
    expect(decision.allowed).toBe(true);
  });

  it("does not crash on a session with no finished segment", () => {
    const decision = decideResume(
      request({
        prior: prior({
          segments: [{ startedAt: FINISHED, firstSequence: 1, lastSequence: 9 }],
        }),
      }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("what a resumed scan re-visits", () => {
  const templateOf = (url: string): string => url.replace(/\/\d+$/, "/{id}");

  it("skips pages the first run already visited", () => {
    const plan = planResume(
      ["https://shop.example.com/a", "https://shop.example.com/b"],
      { visited: ["https://shop.example.com/a"], saturatedTemplates: [] },
      templateOf,
    );
    expect(plan.candidates).toEqual(["https://shop.example.com/b"]);
    expect(plan.skipped[0]?.reason).toBe("already_visited");
  });

  it("skips templates the first run saturated", () => {
    // §9.5.3, and the subtle half: the instances are new URLs, so a resume
    // that only checks `visited` would spend its whole budget re-confirming
    // a template the first run already decided it had seen enough of.
    const plan = planResume(
      [
        "https://shop.example.com/product/41",
        "https://shop.example.com/product/42",
        "https://shop.example.com/cart",
      ],
      { visited: [], saturatedTemplates: ["https://shop.example.com/product/{id}"] },
      templateOf,
    );
    expect(plan.candidates).toEqual(["https://shop.example.com/cart"]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      "template_saturated",
      "template_saturated",
    ]);
  });

  it("records why each URL was skipped rather than dropping it", () => {
    const plan = planResume(
      ["https://shop.example.com/a"],
      { visited: ["https://shop.example.com/a"], saturatedTemplates: [] },
      templateOf,
    );
    expect(plan.skipped).toHaveLength(1);
    expect(plan.candidates).toHaveLength(0);
  });
});

describe("--seed-from", () => {
  it("keeps the URLs and drops the policy", () => {
    // The asymmetry is the point: the user is changing the boundary on
    // purpose, and inheriting the old one would undo the change.
    const plan = seedFrom(["https://shop.example.com/a", "https://old.example.com/b"], (url) =>
      url.startsWith("https://shop.example.com"),
    );
    expect(plan.candidates).toEqual(["https://shop.example.com/a"]);
  });

  it("cannot widen scope", () => {
    // An inherited list is filtered by the new policy here, not at the
    // browser. A URL the old scope allowed and the new one does not is
    // never offered.
    const plan = seedFrom(["https://internal.example.com/admin"], () => false);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("out_of_scope_for_new_policy");
  });

  it("does not silently discard what it dropped", () => {
    const plan = seedFrom(["https://a.example.com/", "https://b.example.com/"], (url) =>
      url.startsWith("https://a."),
    );
    expect(plan.candidates).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
  });
});
