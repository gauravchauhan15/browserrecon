import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_ALLOWANCE_MS,
  MIN_PAGE_ALLOWANCE_MS,
  completenessFor,
  computeEffectiveBudget,
  createBudgetTracker,
  type Budget,
} from "./budget.js";

const budget = (overrides: Partial<Budget> = {}): Budget => ({
  maxPages: 300,
  maxRuntimeMinutes: 60,
  maxFailedActions: 10,
  requestsPerSecond: 5,
  requestsPerPage: 12,
  ...overrides,
});

describe("the effective budget", () => {
  it("catches the configuration the plan actually shipped once", async () => {
    // 2 req/s, 5000 pages, 30 minutes: reads as a 5000-page scan, delivers
    // about 70. This arithmetic exists because that combination was in a
    // draft of the build plan.
    const effective = computeEffectiveBudget(
      budget({
        requestsPerSecond: 2,
        maxPages: 5000,
        maxRuntimeMinutes: 30,
        requestsPerPage: 50,
      }),
    );
    expect(effective.binding).toBe("time");
    expect(effective.effectivePages).toBe(72);
    expect(effective.warning).toContain("will not be reached");
  });

  it("names the page budget when that is what binds", async () => {
    const effective = computeEffectiveBudget(
      budget({ maxPages: 10, maxRuntimeMinutes: 60, requestsPerSecond: 10 }),
    );
    expect(effective.binding).toBe("pages");
    expect(effective.effectivePages).toBe(10);
    expect(effective.warning).toBeUndefined();
  });

  it("does not warn when the page budget is merely a little optimistic", async () => {
    // A warning on every scan is a warning nobody reads.
    const effective = computeEffectiveBudget(
      budget({
        maxPages: 130,
        maxRuntimeMinutes: 10,
        requestsPerSecond: 2,
        requestsPerPage: 10,
      }),
    );
    expect(effective.pagesAffordableInTime).toBe(120);
    expect(effective.warning).toBeUndefined();
  });

  it("states the binding constraint in words a user can act on", async () => {
    expect(computeEffectiveBudget(budget()).summary).toMatch(
      /effective ~\d+ pages \((time|pages)-bound/,
    );
  });

  it("copes with a budget that affords nothing", async () => {
    const effective = computeEffectiveBudget(budget({ maxRuntimeMinutes: 0 }));
    expect(effective.effectivePages).toBe(0);
    expect(effective.binding).toBe("time");
  });
});

describe("termination", () => {
  it("stops at the page budget and says which one fired", async () => {
    const tracker = createBudgetTracker({ budget: budget({ maxPages: 3 }) });
    expect(tracker.pageVisited()).toBeUndefined();
    expect(tracker.pageVisited()).toBeUndefined();
    expect(tracker.pageVisited()).toBe("max_pages");
  });

  it("stops when time runs out", async () => {
    let clock = 0;
    const tracker = createBudgetTracker({
      budget: budget({ maxRuntimeMinutes: 1 }),
      now: () => clock,
    });
    expect(tracker.check()).toBeUndefined();
    clock = 60_001;
    expect(tracker.check()).toBe("max_runtime");
  });

  it("blames the page budget rather than the clock when both are spent", async () => {
    // A scan that reached its page budget should say so; blaming the clock
    // sends the user to change the wrong number.
    let clock = 0;
    const tracker = createBudgetTracker({
      budget: budget({ maxPages: 1, maxRuntimeMinutes: 1 }),
      now: () => clock,
    });
    clock = 60_001;
    expect(tracker.pageVisited()).toBe("max_pages");
  });

  it("counts consecutive failures, not cumulative ones", async () => {
    // A large site will fail occasionally; that is not a reason to stop.
    // Failing repeatedly with no success between means something is wrong.
    const tracker = createBudgetTracker({ budget: budget({ maxFailedActions: 3 }) });
    tracker.actionFailed();
    tracker.actionFailed();
    tracker.actionSucceeded();
    expect(tracker.consecutiveFailures).toBe(0);
    tracker.actionFailed();
    tracker.actionFailed();
    expect(tracker.actionFailed()).toBe("max_failed_actions");
  });
});

describe("pacing a page's share of the clock", () => {
  /** A clock the test drives, so pacing is testable without waiting (§36.1). */
  const at = (times: number[]): (() => number) => {
    let index = 0;
    return () => times[Math.min(index++, times.length - 1)] ?? 0;
  };

  it("divides the time that is left by the pages that are left", async () => {
    // 120 minutes across 120 pages is a minute each. The point of dividing
    // rather than fixing the per-page waits is that the arithmetic holds
    // whatever the budget is — before this, a page got 15s for the document
    // and 2s of quiet whether the scan had two hours or two minutes.
    const tracker = createBudgetTracker({
      budget: budget({ maxPages: 120, maxRuntimeMinutes: 120 }),
      now: at([0, 0]),
    });
    expect(tracker.pageAllowanceMs()).toBe(60_000);
  });

  it("gives later pages less when earlier ones ran long", async () => {
    // Self-correcting is the whole reason this re-divides per page rather
    // than computing a fixed slice up front: a scan whose first pages were
    // slow would otherwise keep spending at a rate it can no longer afford
    // and get cut off by the clock with its queue half-read.
    const clock = at([0, 0, 3_600_000]);
    const tracker = createBudgetTracker({
      budget: budget({ maxPages: 120, maxRuntimeMinutes: 120 }),
      now: clock,
    });
    const first = tracker.pageAllowanceMs();
    for (let i = 0; i < 20; i++) tracker.pageVisited();
    // Half the clock gone, 100 pages left: 36s each, down from 60s.
    expect(tracker.pageAllowanceMs()).toBeLessThan(first);
    expect(tracker.pageAllowanceMs()).toBe(36_000);
  });

  it("never offers less than a real application needs to load", async () => {
    // The reference application took 24.6s to reach domcontentloaded cold
    // and headless.
    // An allowance below the floor is not a fast scan of a page, it is a
    // scan of a page that has not happened yet.
    const tracker = createBudgetTracker({
      budget: budget({ maxPages: 10_000, maxRuntimeMinutes: 1 }),
      now: at([0, 0]),
    });
    expect(tracker.pageAllowanceMs()).toBe(MIN_PAGE_ALLOWANCE_MS);
  });

  it("does not hand the last page everything that is left", async () => {
    // Arithmetically "all the remaining time, for one page" is correct and
    // operationally useless — a two-hour budget with one page to go would
    // sit on a single screen for the rest of the afternoon.
    const tracker = createBudgetTracker({
      budget: budget({ maxPages: 1, maxRuntimeMinutes: 120 }),
      now: at([0, 0]),
    });
    expect(tracker.pageAllowanceMs()).toBe(MAX_PAGE_ALLOWANCE_MS);
  });

  it("still offers the floor once the clock has run out", async () => {
    // The tracker is what stops the scan; the allowance is only advice on
    // how to spend a page. Returning 0 here would have the runner give a
    // page no navigation budget at all and report it as failed, turning a
    // clean "out of time" into a page that looks broken.
    const tracker = createBudgetTracker({
      budget: budget({ maxPages: 120, maxRuntimeMinutes: 1 }),
      now: at([0, 999_999]),
    });
    expect(tracker.pageAllowanceMs()).toBe(MIN_PAGE_ALLOWANCE_MS);
  });
});

describe("completeness", () => {
  it("calls an exhausted budget partial, never an error", async () => {
    // §33: a scan that ran out of time did its job and found less. Reporting
    // failure makes a user re-run it rather than read it.
    expect(completenessFor("max_pages")).toBe("partial");
    expect(completenessFor("max_runtime")).toBe("partial");
    expect(completenessFor("max_failed_actions")).toBe("partial");
  });

  it("calls a drained queue complete", async () => {
    expect(completenessFor("queue_empty")).toBe("complete");
  });
});
