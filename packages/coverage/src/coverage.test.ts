import { describe, expect, it } from "vitest";
import {
  COVERAGE_CAVEAT,
  DIMENSIONS,
  GAP_REASONS,
  MAXIMUM_SCORE,
  NOT_NAVIGABLE_NOTE,
  REMEDIES,
  SCORE_PROVENANCE,
  STATUSES,
  actionable,
  buildCoverage,
  buildDifferential,
  buildGapQueue,
  byReason,
  classifyProbe,
  forReview,
  planProbes,
  prioritise,
  scoreCoverage,
  type CoverageItem,
  type GapInput,
} from "./index.js";

const item = (
  dimension: CoverageItem["dimension"],
  status: CoverageItem["status"],
  id = `${dimension}-${status}-${Math.random()}`,
): CoverageItem => ({ dimension, status, id });

describe("§10C.1/§10C.2: dimensions and statuses", () => {
  it("tracks all thirteen dimensions and nine statuses", () => {
    expect(DIMENSIONS).toHaveLength(13);
    expect(STATUSES).toHaveLength(9);
  });

  it("reports every status for every dimension, so absent is not zero", () => {
    const report = buildCoverage({ items: [item("route", "observed")] });
    const route = report.dimensions.find((d) => d.dimension === "route");
    expect(Object.keys(route?.byStatus ?? {})).toHaveLength(9);
    expect(route?.byStatus.blocked).toBe(0);
  });

  it("gives no ratio for a dimension that found nothing", () => {
    // A ratio over an empty set is not 100% and not 0%; it is a question
    // that was not asked, and either number would be a claim.
    const report = buildCoverage({ items: [] });
    for (const dimension of report.dimensions) {
      expect(dimension.ratio, dimension.dimension).toBeUndefined();
    }
  });

  it("counts correlated as reached and discovered as not", () => {
    // §10A.3's line: a candidate correlated with runtime evidence is
    // surface the scan can speak about; one merely discovered in a bundle is
    // a string someone wrote.
    const report = buildCoverage({
      items: [
        item("static_api_candidate", "correlated"),
        item("static_api_candidate", "discovered"),
      ],
    });
    const dimension = report.dimensions.find((d) => d.dimension === "static_api_candidate");
    expect(dimension?.ratio).toBe(0.5);
  });

  it("carries §10C.6's caveat on the report itself", () => {
    // Not left to whoever renders it. A caveat a consumer has to remember to
    // add goes missing exactly when the report is forwarded.
    const report = buildCoverage({ items: [] });
    expect(report.caveat).toBe(COVERAGE_CAVEAT);
    expect(report.caveat).toMatch(/not a claim of complete/i);
  });

  it("produces §10C.3's summary shape", () => {
    const report = buildCoverage({
      items: [
        item("js_asset", "analyzed"),
        item("js_asset", "deferred"),
        item("runtime_api", "observed"),
        item("static_api_candidate", "unobserved"),
        item("workflow", "observed"),
        item("workflow", "unobserved"),
      ],
    });

    expect(report.summary.javascript.assetsAnalyzed).toBe(1);
    expect(report.summary.javascript.deferredLargeAssets).toBe(1);
    expect(report.summary.api.unobservedCandidates).toBe(1);
    expect(report.summary.workflow).toEqual({ candidates: 2, explored: 1, unexplored: 1 });
  });
});

describe("§10C.6: the score never claims complete coverage", () => {
  const perfect = buildCoverage({
    items: [
      item("first_party_js", "analyzed"),
      item("runtime_api", "observed"),
      item("route", "observed"),
      item("workflow", "observed"),
      item("webmcp", "observed"),
    ],
  });

  it("caps below 1 even when everything discovered was reached", () => {
    // Not a flourish. A scan that reached everything it discovered has not
    // reached what it never discovered, and 1.0 would be a claim about the
    // unmeasured part — the one claim this tool cannot make.
    const scored = scoreCoverage({ coverage: perfect });
    expect(scored.score).toBe(MAXIMUM_SCORE);
    expect(scored.score).toBeLessThan(1);
  });

  it("says what the number means, so a reader does not supply their own", () => {
    const scored = scoreCoverage({ coverage: perfect });
    expect(scored.description).toMatch(/not of the application/i);
    expect(scored.description).toMatch(/reachable/i);
  });

  it("scores zero when nothing was reached", () => {
    const scored = scoreCoverage({
      coverage: buildCoverage({
        items: [item("runtime_api", "unobserved"), item("route", "unobserved")],
      }),
    });
    expect(scored.score).toBe(0);
  });

  it("excludes a dimension that found nothing, rather than scoring it", () => {
    // Scoring it zero punishes a site with no WebMCP for not having any;
    // scoring it one rewards it. Both are claims about the unmeasured.
    const scored = scoreCoverage({
      coverage: buildCoverage({ items: [item("runtime_api", "observed")] }),
    });
    expect(scored.notMeasured).toContain("webmcp");
    expect(scored.score).toBe(MAXIMUM_SCORE);
  });

  it("is lowered by unresolved barriers", () => {
    const withBarriers = scoreCoverage({
      coverage: buildCoverage({
        items: [item("runtime_api", "observed"), item("access_barrier", "blocked")],
      }),
    });
    expect(withBarriers.score).toBeLessThan(MAXIMUM_SCORE);
  });

  it("decomposes into the evidence that produced it", () => {
    const scored = scoreCoverage({ coverage: perfect });
    for (const component of scored.components) {
      expect(component.evidence.length).toBeGreaterThan(2);
      expect(Number.isFinite(component.contribution)).toBe(true);
    }
  });

  it("is deterministic and says it is not from a model", () => {
    // §10C.4: "must never be generated solely by the LLM."
    const a = scoreCoverage({ coverage: perfect });
    const b = scoreCoverage({ coverage: perfect });
    expect(a.score).toBe(b.score);
    expect(SCORE_PROVENANCE).toBe("deterministic");
  });
});

describe("§10C.7: every gap carries a reason", () => {
  const gap = (over: Partial<GapInput> = {}): GapInput => ({
    type: "unobserved_route",
    candidate: "/api/thing",
    reason: "budget_exhausted",
    ...over,
  });

  it("covers all nine reasons, and invents none", () => {
    // The count is deliberate friction: adding a reason should require
    // looking at this test and deciding what it means, not just compiling.
    expect(GAP_REASONS).toHaveLength(9);
    // Both directions. The original only checked that every reason had a
    // remedy, which a remedy for a reason that no longer exists passes
    // happily — and that is how a table ends up with an entry nothing can
    // ever reach.
    expect([...GAP_REASONS].sort()).toEqual(Object.keys(REMEDIES).sort());
  });

  it("gives a remedy for every reason a user can act on", () => {
    for (const reason of GAP_REASONS) {
      if (reason === "not_navigable") continue;
      expect(REMEDIES[reason], reason).toBeTruthy();
      expect((REMEDIES[reason] ?? "").length).toBeGreaterThan(20);
    }
  });

  it("gives not_navigable no remedy, and explains the absence", () => {
    // §10C.7: "a scope boundary, not a coverage failure". Offering a remedy
    // would be suggesting the tool do something it has decided not to do —
    // sending an unsolicited mutating request is active testing.
    expect(REMEDIES.not_navigable).toBeUndefined();
    expect(NOT_NAVIGABLE_NOTE).toMatch(/scope boundary, not a coverage failure/);
    expect(NOT_NAVIGABLE_NOTE).toMatch(/will not invoke/i);
  });

  it("records the setting that caused a policy exclusion", () => {
    // The field §10C.7 singles out: "we could reach this, but you told us
    // not to send POST" is a user decision, not a tool limitation.
    const [entry] = buildGapQueue([
      gap({
        reason: "policy_excluded",
        blockedBecause: "policy.allowed_methods excludes POST",
      }),
    ]);
    expect(entry?.blockedBecause).toContain("allowed_methods");
    expect(entry?.remedy).toMatch(/working as intended/i);
  });

  it("carries the prerequisite state and the workflow that reaches it", () => {
    const [entry] = buildGapQueue([
      gap({
        reason: "requires_state",
        candidate: "/order/{id}/confirmation",
        requiresState: "order_created",
        reachableViaWorkflow: "wf_checkout",
      }),
    ]);
    expect(entry?.requiresState).toBe("order_created");
    expect(entry?.reachableViaWorkflow).toBe("wf_checkout");
  });

  it("separates what a user can act on from what they cannot", () => {
    const queue = buildGapQueue([
      gap({ reason: "budget_exhausted" }),
      gap({ reason: "policy_excluded", candidate: "/excluded" }),
      gap({ reason: "not_navigable", candidate: "POST /api/refund" }),
    ]);
    expect(actionable(queue).map((entry) => entry.reason)).toEqual(["budget_exhausted"]);
  });

  it("counts by reason for the terminal summary", () => {
    const queue = buildGapQueue([
      gap({ reason: "requires_role", candidate: "/a" }),
      gap({ reason: "requires_role", candidate: "/b" }),
      gap({ reason: "budget_exhausted", candidate: "/c" }),
    ]);
    expect(byReason(queue)[0]).toEqual({ reason: "requires_role", count: 2 });
  });
});

describe("the gap queue is ordered for a limited budget", () => {
  it("puts sensitive-sounding surface first", () => {
    // V5 reads this highest-first, so the order decides what a limited
    // budget spends itself on. Ordered by discovery time it spends it on
    // /api/products/2.
    expect(prioritise({ type: "unobserved_route", candidate: "/api/admin/impersonate", reason: "budget_exhausted" })).toBe("high");
    expect(prioritise({ type: "unobserved_route", candidate: "/api/products/{id}", reason: "budget_exhausted" })).toBe("medium");
  });

  it("puts what nobody can act on last", () => {
    expect(prioritise({ type: "unobserved_route", candidate: "/x", reason: "policy_excluded" })).toBe("low");
    expect(prioritise({ type: "unobserved_route", candidate: "/y", reason: "probably_dead" })).toBe("low");
  });

  it("numbers ids in priority order, not discovery order", () => {
    // The queue is read in order; its ids should mean something in it.
    const queue = buildGapQueue([
      { type: "unobserved_route", candidate: "/api/products", reason: "budget_exhausted" },
      { type: "unobserved_route", candidate: "/api/admin/keys", reason: "budget_exhausted" },
    ]);
    expect(queue[0]?.gap_id).toBe("gap_0001");
    expect(queue[0]?.candidate).toBe("/api/admin/keys");
  });

  it("is deterministic", () => {
    const build = () =>
      JSON.stringify(
        buildGapQueue([
          { type: "unobserved_route", candidate: "/b", reason: "budget_exhausted" },
          { type: "unobserved_route", candidate: "/a", reason: "budget_exhausted" },
        ]),
      );
    expect(build()).toBe(build());
  });
});

describe("§10C.7: liveness probing", () => {
  it("reads a gated response as confirmation, not failure", () => {
    // The point worth stating: a 401 is *more* informative than a 200. It
    // says the endpoint exists and something protects it, for one request.
    for (const status of [401, 403]) {
      const verdict = classifyProbe(status);
      expect(verdict.outcome, String(status)).toBe("exists_gated");
      expect(verdict.meaning).toMatch(/exists/);
    }
  });

  it("reads 405 as the endpoint being real", () => {
    expect(classifyProbe(405).outcome).toBe("exists_wrong_method");
  });

  it("reads 404 and 410 as probably dead", () => {
    expect(classifyProbe(404).outcome).toBe("probably_dead");
    expect(classifyProbe(410).outcome).toBe("probably_dead");
  });

  it("promotes only a genuinely reachable endpoint", () => {
    expect(classifyProbe(200).promote).toBe(true);
    expect(classifyProbe(401).promote).toBe(false);
  });

  it("says unknown rather than guessing", () => {
    expect(classifyProbe(500).outcome).toBe("unknown");
    expect(classifyProbe(undefined).outcome).toBe("unknown");
  });

  it("probes nothing unless asked", () => {
    // Opt-in "since it issues requests the application itself never made".
    const planned = planProbes({
      candidates: ["https://shop.example.com/api/x"],
      enabled: false,
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
      allowed: () => true,
    });
    expect(planned.probes).toEqual([]);
    expect(planned.skipped[0]?.reason).toContain("--probe-liveness");
  });

  it("never uses a method outside policy", () => {
    const planned = planProbes({
      candidates: ["https://shop.example.com/api/x"],
      enabled: true,
      allowedMethods: ["GET"],
      allowed: () => true,
    });
    expect(planned.probes).toEqual([]);
    expect(planned.skipped[0]?.reason).toContain("HEAD nor OPTIONS");
  });

  it("probes once per unique candidate", () => {
    const planned = planProbes({
      candidates: ["https://shop.example.com/api/x", "https://shop.example.com/api/x"],
      enabled: true,
      allowedMethods: ["HEAD"],
      allowed: () => true,
    });
    expect(planned.probes).toHaveLength(1);
    expect(planned.skipped[0]?.reason).toContain("one probe per unique candidate");
  });

  it("stays inside the target policy", () => {
    const planned = planProbes({
      candidates: ["https://elsewhere.example.net/api/x"],
      enabled: true,
      allowedMethods: ["HEAD"],
      allowed: () => false,
    });
    expect(planned.probes).toEqual([]);
    expect(planned.skipped[0]?.reason).toContain("outside the target policy");
  });

  it("caps the total, so a large gap queue is not a large amount of traffic", () => {
    const planned = planProbes({
      candidates: Array.from({ length: 200 }, (_, n) => `https://shop.example.com/api/${n}`),
      enabled: true,
      allowedMethods: ["HEAD"],
      allowed: () => true,
      maxProbes: 10,
    });
    expect(planned.probes).toHaveLength(10);
    expect(planned.skipped.length).toBe(190);
  });
});

describe("§12.4: multi-role differential", () => {
  const order = ["anonymous", "customer", "admin"];

  it("recognises a consistent authorization boundary", () => {
    const [entry] = buildDifferential({
      privilegeOrder: order,
      observations: [
        { target: "/admin/users", role: "admin", outcome: "observed", status: 200 },
        { target: "/admin/users", role: "customer", outcome: "blocked", status: 403 },
        { target: "/admin/users", role: "anonymous", outcome: "blocked", status: 302 },
      ],
    });
    expect(entry?.verdict).toBe("consistent_boundary");
    expect(entry?.flaggedForReview).toBe(false);
  });

  it("flags §12.4's own worked example", () => {
    // admin and customer both reach /api/reports/export, anonymous is
    // blocked. The split is consistent with the privilege order — so this is
    // flagged on the endpoint's *name*, and the note says so, because plenty
    // of applications let a customer export their own reports.
    const [entry] = buildDifferential({
      privilegeOrder: order,
      observations: [
        { target: "/api/reports/export", role: "admin", outcome: "observed", status: 200 },
        { target: "/api/reports/export", role: "customer", outcome: "observed", status: 200 },
        { target: "/api/reports/export", role: "anonymous", outcome: "blocked", status: 401 },
      ],
    });
    expect(entry?.verdict).toBe("sensitive_surface_reached");
    expect(entry?.flaggedForReview).toBe(true);
    expect(entry?.note).toMatch(/rests on the name/i);
  });

  it("flags a genuine contradiction more strongly than a name", () => {
    // A customer got in where an admin was blocked. That contradicts the
    // privilege order itself, which is evidence of a different quality from
    // an endpoint being called "export".
    const [entry] = buildDifferential({
      privilegeOrder: order,
      observations: [
        { target: "/api/widgets", role: "admin", outcome: "blocked", status: 403 },
        { target: "/api/widgets", role: "customer", outcome: "observed", status: 200 },
      ],
    });
    expect(entry?.verdict).toBe("lower_privilege_reachable");
    expect(entry?.flaggedForReview).toBe(true);
  });

  it("does not flag ordinary surface a customer can reach", () => {
    const [entry] = buildDifferential({
      privilegeOrder: order,
      observations: [
        { target: "/api/products", role: "admin", outcome: "observed" },
        { target: "/api/products", role: "customer", outcome: "observed" },
        { target: "/api/products", role: "anonymous", outcome: "blocked" },
      ],
    });
    expect(entry?.verdict).toBe("consistent_boundary");
    expect(entry?.flaggedForReview).toBe(false);
  });

  it("calls it evidence, never a finding", () => {
    // §12.4 rule 3: "A reachability difference is evidence, not a finding."
    // The vocabulary is the guardrail — a field called `severity` would get
    // filled in by someone eventually.
    const entries = buildDifferential({
      privilegeOrder: order,
      observations: [
        { target: "/api/admin/keys", role: "admin", outcome: "observed" },
        { target: "/api/admin/keys", role: "customer", outcome: "observed" },
        { target: "/api/admin/keys", role: "anonymous", outcome: "blocked" },
      ],
    });
    const serialized = JSON.stringify(entries).toLowerCase();
    for (const word of ["vulnerab", "severity", "exploit", "critical"]) {
      expect(serialized, `the differential used "${word}"`).not.toContain(word);
    }
    // Both flagged verdicts say what they are not.
    expect(forReview(entries)[0]?.note).toMatch(/not a (?:confirmed|finding)|evidence for review/i);
  });

  it("says nothing when only one role attempted it", () => {
    const [entry] = buildDifferential({
      privilegeOrder: order,
      observations: [{ target: "/x", role: "admin", outcome: "observed" }],
    });
    expect(entry?.verdict).toBe("insufficient_roles");
    expect(entry?.flaggedForReview).toBe(false);
  });

  it("recognises uniformly open and uniformly blocked surface", () => {
    const open = buildDifferential({
      privilegeOrder: order,
      observations: [
        { target: "/public", role: "admin", outcome: "observed" },
        { target: "/public", role: "anonymous", outcome: "observed" },
      ],
    });
    expect(open[0]?.verdict).toBe("uniformly_open");

    const blocked = buildDifferential({
      privilegeOrder: order,
      observations: [
        { target: "/nobody", role: "admin", outcome: "blocked" },
        { target: "/nobody", role: "anonymous", outcome: "blocked" },
      ],
    });
    expect(blocked[0]?.verdict).toBe("uniformly_blocked");
  });

  it("does not treat an unranked role as low-privilege", () => {
    // Calling an unknown role "lower privilege" raises a false flag against
    // a role the user never described. Privilege order is supplied because
    // only they know it.
    const [entry] = buildDifferential({
      privilegeOrder: ["anonymous", "admin"],
      observations: [
        { target: "/x", role: "mystery", outcome: "observed" },
        { target: "/x", role: "admin", outcome: "blocked" },
      ],
    });
    expect(entry?.flaggedForReview).toBe(false);
  });
});
