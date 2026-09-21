/**
 * Budgets, coherence and termination — build plan §5A.2, §7.2, §8.3, §27.3;
 * dev plan BR-M1-14.
 *
 * ## One set of budget fields, not two
 *
 * §5A.2 is explicit that the Deterministic Explorer stops at the same limits
 * the AI Explorer will. Two parallel sets would mean `--ai` silently changed
 * the boundary a scan runs inside, which is the sort of difference nobody
 * notices until a scan behaves unlike the one they tested.
 *
 * ## The effective budget, because the numbers interact
 *
 * §8.3 requires the scan to print which limit actually binds. An earlier
 * draft of the plan shipped `2 req/sec` with `max_pages: 5000` and a 30
 * minute cap — a page budget unreachable by roughly seventy times, which read
 * as "we will visit 5000 pages" and meant "we will visit 72". The arithmetic
 * is done here and stated up front, so a user sees the real number before the
 * scan rather than the aspiration.
 */

export interface Budget {
  readonly maxPages: number;
  readonly maxRuntimeMinutes: number;
  /** Consecutive failed actions before the phase gives up. */
  readonly maxFailedActions: number;
  /** Requests per second the rate profile permits. */
  readonly requestsPerSecond: number;
  /** Requests a single page costs, on average — document plus subresources. */
  readonly requestsPerPage: number;
}

/** Which limit will actually stop the scan. */
export type BindingConstraint = "pages" | "time" | "none";

export interface EffectiveBudget {
  /** Pages the scan can realistically reach. */
  readonly effectivePages: number;
  readonly binding: BindingConstraint;
  /** Pages the rate and time budget allow, ignoring maxPages. */
  readonly pagesAffordableInTime: number;
  /** One line for the scan's opening output (§8.3). */
  readonly summary: string;
  /**
   * Set when `maxPages` is so far out of reach that stating it would mislead.
   *
   * The specific failure this exists to prevent: a configuration that reads
   * as a 5000-page scan and delivers 72.
   */
  readonly warning?: string | undefined;
}

/** Beyond this ratio, the page budget is decoration rather than a limit. */
const MISLEADING_RATIO = 2;

export function computeEffectiveBudget(budget: Budget): EffectiveBudget {
  const seconds = budget.maxRuntimeMinutes * 60;
  const requestsAffordable = budget.requestsPerSecond * seconds;
  const pagesAffordableInTime = Math.max(
    0,
    Math.floor(requestsAffordable / Math.max(1, budget.requestsPerPage)),
  );

  const effectivePages = Math.min(budget.maxPages, pagesAffordableInTime);
  const binding: BindingConstraint =
    effectivePages === 0
      ? "time"
      : pagesAffordableInTime < budget.maxPages
        ? "time"
        : budget.maxPages < pagesAffordableInTime
          ? "pages"
          : "none";

  const summary =
    binding === "time"
      ? `effective ~${effectivePages} pages (time-bound at ${budget.maxRuntimeMinutes} min)`
      : `effective ~${effectivePages} pages (pages-bound)`;

  const warning =
    binding === "time" && budget.maxPages > pagesAffordableInTime * MISLEADING_RATIO
      ? `max_pages is ${budget.maxPages}, but only ~${pagesAffordableInTime} are reachable at ` +
        `${budget.requestsPerSecond} req/s in ${budget.maxRuntimeMinutes} min — the page budget will not be reached`
      : undefined;

  return {
    effectivePages,
    binding,
    pagesAffordableInTime,
    summary,
    ...(warning === undefined ? {} : { warning }),
  };
}

/** Why exploration stopped. */
export const STOP_REASONS = [
  "queue_empty",
  "max_pages",
  "max_runtime",
  "max_failed_actions",
  "cancelled",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export interface BudgetTracker {
  /** Record a visited page. Returns the reason to stop, if one now applies. */
  pageVisited(): StopReason | undefined;
  /** Record a failed action. Consecutive failures are what count. */
  actionFailed(): StopReason | undefined;
  /** Record a successful action, which resets the failure run. */
  actionSucceeded(): void;
  /** Whether time has run out, checked between actions. */
  check(): StopReason | undefined;
  readonly pagesVisited: number;
  readonly consecutiveFailures: number;
  readonly elapsedMs: number;
}

export interface TrackerOptions {
  readonly budget: Budget;
  /** Injected so termination is testable without waiting (§36.1). */
  readonly now?: (() => number) | undefined;
}

export function createBudgetTracker(options: TrackerOptions): BudgetTracker {
  const now = options.now ?? ((): number => Date.now());
  const started = now();
  const limitMs = options.budget.maxRuntimeMinutes * 60_000;

  let pages = 0;
  let failures = 0;

  const timeUp = (): StopReason | undefined =>
    now() - started >= limitMs ? "max_runtime" : undefined;

  return {
    pageVisited() {
      pages += 1;
      // Pages first: a scan that has reached its page budget should say so
      // rather than blaming the clock that also happened to run out.
      if (pages >= options.budget.maxPages) return "max_pages";
      return timeUp();
    },
    actionFailed() {
      failures += 1;
      if (failures >= options.budget.maxFailedActions) return "max_failed_actions";
      return timeUp();
    },
    actionSucceeded() {
      // Consecutive, not cumulative. A scan of a large site will fail
      // occasionally and that is not a reason to stop; failing repeatedly
      // with no success in between means something is actually wrong.
      failures = 0;
    },
    check: timeUp,
    get pagesVisited() {
      return pages;
    },
    get consecutiveFailures() {
      return failures;
    },
    get elapsedMs() {
      return now() - started;
    },
  };
}

/** How complete the run was, for the report (§10C). */
export type Completeness = "complete" | "partial";

/**
 * Budget exhaustion is `partial`, never an error.
 *
 * A scan that ran out of time did its job and found less. Reporting that as a
 * failure would make a user re-run it rather than read it, and §33 already
 * treats incomplete coverage as a normal outcome to be stated.
 */
export function completenessFor(reason: StopReason): Completeness {
  return reason === "queue_empty" ? "complete" : "partial";
}
