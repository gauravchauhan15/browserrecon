/**
 * The coverage gap queue — build plan §10C.5, §10C.7; dev plan BR-M3-09,
 * BR-M3-09b.
 *
 * §10C.5's rule: "A finding is not allowed to silently disappear just because
 * the Deterministic Explorer's fixed rules didn't reach it."
 *
 * ## A reason is not optional
 *
 * §10C.7 opens by saying why: "'Unobserved' is not one condition. Lumping
 * every unreached candidate together produces a gap list nobody can act on."
 * Eight typed reasons, each with a response — and the responses differ
 * completely. `budget_exhausted` means run it again with more; `requires_role`
 * means scan as someone else; `policy_excluded` means it is working as
 * intended and needs no action at all.
 *
 * ## The honest answer is often "you told us not to"
 *
 * §10C.7 again: *"we could reach this, but you told us not to send POST"* is
 * a **user decision, not a tool limitation, and the report should say so
 * plainly.** `blockedBecause` carries that, and it is the field most likely
 * to change what someone does next.
 */

/** §10C.7's eight, exactly. */
export const GAP_REASONS = [
  "requires_state",
  "requires_input",
  "requires_role",
  "not_navigable",
  "probably_dead",
  "blocked_by_barrier",
  "budget_exhausted",
  "depth_limited",
  "policy_excluded",
] as const;

export type GapReason = (typeof GAP_REASONS)[number];

export const GAP_TYPES = [
  "unobserved_route",
  "unobserved_js_api_candidate",
  "unobserved_imported_url",
  "unexplored_workflow",
  "unanalyzed_js_asset",
  "blocked_origin",
] as const;

export type GapType = (typeof GAP_TYPES)[number];

export type GapPriority = "high" | "medium" | "low";

export interface CoverageGap {
  readonly gap_id: string;
  readonly type: GapType;
  readonly candidate: string;
  readonly reason: GapReason;
  /** What to do about it. Absent only where genuinely nothing applies. */
  readonly remedy?: string | undefined;
  readonly priority: GapPriority;
  readonly sourceScript?: string | undefined;
  readonly workflow?: string | undefined;
  /** The state a workflow must reach first (§10C.7's example). */
  readonly requiresState?: string | undefined;
  readonly reachableViaWorkflow?: string | undefined;
  /**
   * The setting that stopped it, where a setting did.
   *
   * The field §10C.7 singles out: "the honest answer is often 'we could
   * reach this, but you told us not to send POST' — which is a user
   * decision, not a tool limitation."
   */
  readonly blockedBecause?: string | undefined;
}

/**
 * §10C.7's response column.
 *
 * `not_navigable` has no remedy on purpose, and the plan is explicit about
 * why: `POST /api/refund` cannot be visited by a browser, and BrowserRecon
 * "deliberately will not invoke it" — sending an unsolicited mutating request
 * is active testing, which is V7 and deferred. It is "a scope boundary, not a
 * coverage failure", so offering a remedy would be suggesting the tool do
 * something it has decided not to do.
 */
export const REMEDIES: Readonly<Record<GapReason, string | undefined>> = {
  requires_state:
    "Reachable once a workflow establishes the prerequisite state. `agent` mode can complete it when state_changing_actions is enabled.",
  requires_input:
    "Behind input validation. Supply a test data profile (§12.5) with values your application accepts.",
  requires_role:
    "Reachable by a role this scan did not run as. Add an --auth-profile for that role.",
  not_navigable: undefined,
  probably_dead:
    "A liveness probe found nothing there. Retained at low priority in case the probe was wrong.",
  blocked_by_barrier:
    "An access barrier stopped the scan. Barriers are recorded, never circumvented — resolve it at the application or accept the gap.",
  budget_exhausted:
    "The scan ran out of pages or time. Raise the budget, or resume this session.",
  // Distinct from `budget_exhausted` because the remedy is different and
  // the reader cannot guess which one applies. "The scan ran out" sends
  // someone to --max-pages or `resume`, neither of which reaches a URL that
  // was never queued: the crawl was told how far to go and went that far.
  depth_limited:
    "Further from the seed than --max-depth allows. Raise it to reach these; the default of 3 is deliberately shallow.",
  policy_excluded:
    "Excluded by your own policy. Working as intended; listed for transparency.",
};

/**
 * Why `not_navigable` carries no remedy, in the object itself.
 *
 * A reader seeing an empty remedy column deserves the reason rather than the
 * impression that one is missing.
 */
export const NOT_NAVIGABLE_NOTE =
  "An API endpoint, not a page. A browser cannot visit it, and BrowserRecon will " +
  "not invoke it: an unsolicited mutating request is active testing, which is out " +
  "of scope. This is a scope boundary, not a coverage failure.";

/** Names that suggest surface worth reaching before generic CRUD. */
const SENSITIVE = /(?:admin|internal|debug|export|download|refund|payout|transfer|invoice|billing|payment|token|key|secret|password|credential|impersonat|sudo|su|role|permission|acl|grant|audit|backup|restore|migrat|config|setting|delete|purge)/i;

/**
 * Prioritise.
 *
 * §10C.5's queue is consumed by V5 highest-first, so the order decides what
 * a limited budget spends itself on. Sensitive-sounding names come before
 * generic CRUD because that is where the interesting surface is, and a gap
 * queue ordered by discovery time spends its budget on `/api/products/2`.
 */
export function prioritise(gap: Omit<CoverageGap, "gap_id" | "priority">): GapPriority {
  // Nothing to act on and nothing to reach: lowest, whatever it is called.
  if (gap.reason === "policy_excluded" || gap.reason === "probably_dead") return "low";

  if (SENSITIVE.test(gap.candidate)) return "high";

  // Something the scan could genuinely have reached with a different
  // decision is worth more than something structurally out of reach.
  if (
    gap.reason === "budget_exhausted" ||
    gap.reason === "depth_limited" ||
    gap.reason === "requires_state" ||
    gap.reason === "requires_role" ||
    gap.reason === "requires_input"
  ) {
    return "medium";
  }

  return "low";
}

export interface GapInput extends Omit<CoverageGap, "gap_id" | "priority" | "remedy"> {
  readonly priority?: GapPriority | undefined;
}

/**
 * Build the queue.
 *
 * Ids are assigned after sorting, so `gap_0001` is the highest-priority gap
 * rather than whichever was found first — the queue is read in order and its
 * ids should mean something in that order.
 */
export function buildGapQueue(gaps: readonly GapInput[]): readonly CoverageGap[] {
  const order: Record<GapPriority, number> = { high: 0, medium: 1, low: 2 };

  return [...gaps]
    .map((gap) => ({ ...gap, priority: gap.priority ?? prioritise(gap) }))
    .sort(
      (a, b) =>
        order[a.priority] - order[b.priority] ||
        a.type.localeCompare(b.type) ||
        a.candidate.localeCompare(b.candidate),
    )
    .map((gap, index): CoverageGap => {
      const remedy = REMEDIES[gap.reason];
      return {
        gap_id: `gap_${String(index + 1).padStart(4, "0")}`,
        type: gap.type,
        candidate: gap.candidate,
        reason: gap.reason,
        ...(remedy === undefined ? {} : { remedy }),
        priority: gap.priority,
        ...(gap.sourceScript === undefined ? {} : { sourceScript: gap.sourceScript }),
        ...(gap.workflow === undefined ? {} : { workflow: gap.workflow }),
        ...(gap.requiresState === undefined ? {} : { requiresState: gap.requiresState }),
        ...(gap.reachableViaWorkflow === undefined
          ? {}
          : { reachableViaWorkflow: gap.reachableViaWorkflow }),
        ...(gap.blockedBecause === undefined ? {} : { blockedBecause: gap.blockedBecause }),
      };
    });
}

/** Gaps a user could act on, which is not the same as all of them. */
export function actionable(gaps: readonly CoverageGap[]): readonly CoverageGap[] {
  return gaps.filter((gap) => gap.remedy !== undefined && gap.reason !== "policy_excluded");
}

/** Counts by reason, for the terminal summary's "why coverage stopped". */
export function byReason(
  gaps: readonly CoverageGap[],
): readonly { readonly reason: GapReason; readonly count: number }[] {
  const counts = new Map<GapReason, number>();
  for (const gap of gaps) counts.set(gap.reason, (counts.get(gap.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
