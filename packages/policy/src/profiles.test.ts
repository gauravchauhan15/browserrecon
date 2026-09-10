import { describe, expect, it } from "vitest";
import {
  ESTIMATED_REQUESTS_PER_PAGE,
  RATE_PROFILES,
  THOROUGHNESS_LEVELS,
  computeEffectiveBudget,
} from "./profiles.js";

describe("computeEffectiveBudget", () => {
  it("reproduces the arithmetic that exposed the original defect", () => {
    // 2 req/sec over 30 minutes buys 3,600 requests, about 72 pages at ~50
    // requests per render. The original config claimed max_pages: 5000.
    const budget = computeEffectiveBudget({
      maxRequestsPerSecond: 2,
      maxConcurrency: 2,
      maxPages: 5000,
      maxRuntimeMinutes: 30,
    });

    expect(budget.requestsAvailable).toBe(3600);
    expect(budget.pagesReachable).toBe(72);
    expect(budget.effectivePages).toBe(72);
    expect(budget.binding).toBe("time");
    expect(budget.maxPagesUnreachable).toBe(true);
  });

  it("names time as the binding constraint when the clock runs out first", () => {
    const budget = computeEffectiveBudget({
      maxRequestsPerSecond: 1,
      maxConcurrency: 1,
      maxPages: 10_000,
      maxRuntimeMinutes: 10,
    });
    expect(budget.binding).toBe("time");
    expect(budget.effectivePages).toBeLessThan(10_000);
  });

  it("names pages as the binding constraint when the page budget is the smaller one", () => {
    const budget = computeEffectiveBudget({
      maxRequestsPerSecond: 20,
      maxConcurrency: 4,
      maxPages: 10,
      maxRuntimeMinutes: 60,
    });
    expect(budget.binding).toBe("pages");
    expect(budget.effectivePages).toBe(10);
  });

  it("does not cry wolf over modest headroom", () => {
    // A page budget slightly above what the clock allows is a reasonable
    // choice; only one many times higher is a misconfiguration worth naming.
    const budget = computeEffectiveBudget({
      maxRequestsPerSecond: 5,
      maxConcurrency: 2,
      maxPages: 400,
      maxRuntimeMinutes: 60,
    });
    expect(budget.pagesReachable).toBe(360);
    expect(budget.maxPagesUnreachable).toBe(false);
  });

  it("derives pages from the documented per-page estimate", () => {
    const budget = computeEffectiveBudget({
      maxRequestsPerSecond: ESTIMATED_REQUESTS_PER_PAGE,
      maxConcurrency: 1,
      maxPages: 10_000,
      maxRuntimeMinutes: 1,
    });
    // 50 req/sec for 60 seconds = 3000 requests = 60 pages at 50 each.
    expect(budget.pagesReachable).toBe(60);
  });
});

describe("RATE_PROFILES", () => {
  it("keeps polite genuinely gentle", () => {
    // First contact with an unfamiliar target: one request at a time.
    expect(RATE_PROFILES.polite.maxRequestsPerSecond).toBeLessThanOrEqual(1);
    expect(RATE_PROFILES.polite.maxConcurrency).toBe(1);
  });

  it("sits normal well below anything that would stress a modest site", () => {
    expect(RATE_PROFILES.normal.maxRequestsPerSecond).toBeLessThanOrEqual(5);
  });
});

describe("THOROUGHNESS_LEVELS", () => {
  it("increases sampling depth without touching request rate", () => {
    // The point of the split: thoroughness spends the budget differently, it
    // does not enlarge it or hit the target harder (§8.3).
    const { shallow, normal, deep } = THOROUGHNESS_LEVELS;
    expect(shallow.instancesPerTemplate).toBeLessThan(normal.instancesPerTemplate);
    expect(normal.instancesPerTemplate).toBeLessThan(deep.instancesPerTemplate);

    for (const level of Object.values(THOROUGHNESS_LEVELS)) {
      expect(level).not.toHaveProperty("maxRequestsPerSecond");
    }
  });

  it("samples at least one instance per template at every level", () => {
    for (const [name, level] of Object.entries(THOROUGHNESS_LEVELS)) {
      expect(level.instancesPerTemplate, name).toBeGreaterThanOrEqual(1);
      expect(level.divergenceSampleCap, name).toBeGreaterThanOrEqual(
        level.instancesPerTemplate,
      );
    }
  });
});
