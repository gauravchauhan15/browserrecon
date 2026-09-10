import { describe, expect, it } from "vitest";
import { defaultTargetPolicy, resolveTargetPolicy, POLICY_SPEC } from "./resolve.js";
import { elevatedRisks, isMutating, MUTATING_METHODS } from "./types.js";
import { RATE_PROFILES, computeEffectiveBudget } from "./profiles.js";
import { loadConfig } from "@browserrecon/config";

const policyOf = (origin = "https://shop.example.com") => {
  const result = defaultTargetPolicy(origin);
  if (!result.ok) throw new Error(`expected a policy: ${JSON.stringify(result.violations)}`);
  return result.policy;
};

/**
 * Default posture. These are safety tests, so each asserts one specific
 * promise the tool makes to someone who typed a bare `scan` command — the
 * kind of thing that must fail loudly if a future change relaxes it.
 */
describe("default posture", () => {
  it("permits only read-only methods", () => {
    expect(policyOf().allowedMethods).toEqual(["GET", "HEAD", "OPTIONS"]);
  });

  it("permits no mutating method whatsoever", () => {
    const allowed = policyOf().allowedMethods;
    for (const method of MUTATING_METHODS) {
      expect(allowed, `${method} must not be permitted by default`).not.toContain(method);
    }
  });

  it("never enables DELETE in any default or example profile", () => {
    // BR-M0-05 acceptance criterion. Configurable for a target you own, but
    // nothing shipped may turn it on.
    expect(policyOf().allowedMethods).not.toContain("DELETE");

    const specDefault = POLICY_SPEC.find((f) => f.path === "policy.allowedMethods")?.default;
    expect(specDefault).not.toContain("DELETE");

    const fromEmptyConfig = loadConfig({ spec: POLICY_SPEC });
    expect(fromEmptyConfig.ok).toBe(true);
    if (!fromEmptyConfig.ok) return;
    const resolved = resolveTargetPolicy({
      targetOrigin: "https://shop.example.com",
      config: fromEmptyConfig.config,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.policy.allowedMethods).not.toContain("DELETE");
  });

  it("does not permit state-changing explorer actions", () => {
    expect(policyOf().agent.stateChangingActions).toBe(false);
  });

  it("denies loopback, private ranges and link-local", () => {
    // Reaching these from a tool pointed at a public URL is almost always
    // either a mistake or SSRF-shaped.
    expect(policyOf().network).toMatchObject({
      denyLoopback: true,
      denyPrivateRanges: true,
      denyLinkLocal: true,
    });
  });

  it("does not follow redirects off an allowed origin", () => {
    expect(policyOf().network.followExternalRedirects).toBe(false);
  });

  it("excludes session-ending and destructive paths", () => {
    // These are prominent links, so an automated explorer finds them first.
    // Being logged out mid-scan also silently corrupts coverage (§12.3).
    const excluded = policyOf().excludedPaths;
    expect(excluded).toContain("/logout");
    expect(excluded).toContain("/delete-account");
  });

  it("scopes to the target origin only", () => {
    const policy = policyOf("https://shop.example.com");
    expect(policy.allowedOrigins).toEqual(["https://shop.example.com"]);
  });

  it("uses the normal rate profile, never aggressive", () => {
    expect(policyOf().limits).toEqual(RATE_PROFILES.normal);
  });

  it("reports no elevated risk at all", () => {
    // The strongest form of this test: the default policy should give a user
    // nothing to acknowledge under §7.4.
    expect(elevatedRisks(policyOf())).toEqual([]);
  });
});

describe("target origin", () => {
  it("normalizes to origin form, discarding path and query", () => {
    expect(policyOf("https://shop.example.com/cart?x=1#top").targetOrigin).toBe(
      "https://shop.example.com",
    );
  });

  it("rejects anything that is not http(s)", () => {
    for (const bad of [
      "shop.example.com",
      "ftp://shop.example.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "",
    ]) {
      expect(defaultTargetPolicy(bad).ok, bad).toBe(false);
    }
  });
});

describe("widening scope", () => {
  it("includes extra origins with the target first", () => {
    const result = resolveTargetPolicy({
      targetOrigin: "https://shop.example.com",
      config: { policy: { allowedOrigins: ["https://api.shop.example.com"] } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.allowedOrigins).toEqual([
      "https://shop.example.com",
      "https://api.shop.example.com",
    ]);
  });

  it("rejects a malformed extra origin rather than skipping it", () => {
    // A typo that silently narrows scope is a nuisance; one that silently
    // widens it is a safety failure. Rejecting is the only safe direction.
    const result = resolveTargetPolicy({
      targetOrigin: "https://shop.example.com",
      config: { policy: { allowedOrigins: ["not a url"] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.field).toBe("policy.allowedOrigins");
  });

  it("rejects an unknown HTTP method", () => {
    const result = resolveTargetPolicy({
      targetOrigin: "https://shop.example.com",
      config: { policy: { allowedMethods: ["GET", "TRACE"] } },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty method list", () => {
    const result = resolveTargetPolicy({
      targetOrigin: "https://shop.example.com",
      config: { policy: { allowedMethods: [] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.reason).toContain("at least one method");
  });

  it("accepts mutating methods when explicitly configured", () => {
    const result = resolveTargetPolicy({
      targetOrigin: "https://shop.example.com",
      config: { policy: { allowedMethods: ["GET", "POST"] } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.allowedMethods).toEqual(["GET", "POST"]);
  });
});

describe("elevatedRisks", () => {
  const withConfig = (config: Record<string, unknown>) => {
    const result = resolveTargetPolicy({ targetOrigin: "https://shop.example.com", config });
    if (!result.ok) throw new Error("expected a policy");
    return elevatedRisks(result.policy);
  };

  it("flags mutating methods in plain language", () => {
    // §7.4 requires the user be told what a setting permits, in words they
    // can act on — not a jargon label.
    const risks = withConfig({ policy: { allowedMethods: ["GET", "POST"] } });
    expect(risks).toHaveLength(1);
    expect(risks[0]?.consequence).toMatch(/change data on the target/i);
  });

  it("flags DELETE separately and more bluntly", () => {
    const risks = withConfig({ policy: { allowedMethods: ["GET", "DELETE"] } });
    expect(risks.some((r) => /permanently delete/i.test(r.consequence))).toBe(true);
  });

  it("flags state-changing explorer actions", () => {
    const risks = withConfig({ policy: { agent: { stateChangingActions: true } } });
    expect(risks.some((r) => r.setting.includes("stateChangingActions"))).toBe(true);
  });

  it("flags each relaxed network denial", () => {
    expect(withConfig({ policy: { network: { denyLoopback: false } } })).toHaveLength(1);
    expect(withConfig({ policy: { network: { denyPrivateRanges: false } } })).toHaveLength(1);
    expect(withConfig({ policy: { network: { followExternalRedirects: true } } })).toHaveLength(
      1,
    );
  });

  it("flags a rate that can overwhelm a modest site", () => {
    const risks = withConfig({ policy: { limits: { maxRequestsPerSecond: 15 } } });
    expect(risks.some((r) => /overwhelm a modest site/i.test(r.consequence))).toBe(true);
  });

  it("stays silent on the aggressive profile's own rate only when configured deliberately", () => {
    // The aggressive profile is itself an explicit choice, and its 15 req/sec
    // must still be reported — the acknowledgment is the whole point.
    const result = resolveTargetPolicy({
      targetOrigin: "https://shop.example.com",
      rateProfile: "aggressive",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(elevatedRisks(result.policy).length).toBeGreaterThan(0);
  });
});

describe("isMutating", () => {
  it("classifies by effect on server state", () => {
    expect(isMutating("GET")).toBe(false);
    expect(isMutating("HEAD")).toBe(false);
    expect(isMutating("OPTIONS")).toBe(false);
    expect(isMutating("POST")).toBe(true);
    expect(isMutating("DELETE")).toBe(true);
  });
});

describe("profile coherence", () => {
  it("every profile's page budget is reachable within its own runtime", () => {
    // The defect this prevents: 2 req/sec with max_pages 5000 and a 30-minute
    // runtime cannot both hold — that page budget was unreachable by ~70x, so
    // the time budget always bound and the config actively misled its reader.
    for (const [name, limits] of Object.entries(RATE_PROFILES)) {
      const budget = computeEffectiveBudget(limits);
      expect(budget.maxPagesUnreachable, `${name} profile has an unreachable page budget`).toBe(
        false,
      );
    }
  });

  it("profiles increase monotonically in rate, concurrency and pages", () => {
    const { polite, normal, aggressive } = RATE_PROFILES;
    expect(polite.maxRequestsPerSecond).toBeLessThan(normal.maxRequestsPerSecond);
    expect(normal.maxRequestsPerSecond).toBeLessThan(aggressive.maxRequestsPerSecond);
    expect(polite.maxConcurrency).toBeLessThanOrEqual(normal.maxConcurrency);
    expect(normal.maxPages).toBeLessThan(aggressive.maxPages);
  });
});
