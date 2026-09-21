/**
 * Phase outcomes and failure isolation — build plan §8.5 rule 3, §9.3;
 * dev plan BR-M1-28.
 *
 * ## Why isolation, and where it stops
 *
 * §8.5 rule 3 says a crawler failure is not fatal. Generalised: a scan is a
 * pipeline of phases that each produce *less* when they go wrong, and the
 * useful behaviour is almost always to continue with less rather than to
 * abandon the run. A user who waited eleven minutes for a scan does not want
 * "katana exited 1" and nothing else.
 *
 * The exception is the policy phase. Everything downstream touches the
 * network on the user's behalf, and §32.10 requires the boundary to be
 * settled before a browser action can happen. A policy phase that failed and
 * was "isolated" would mean scanning without a validated boundary, which is
 * the one failure that must stop the run.
 *
 * ## Degraded is not failed, and neither is silent
 *
 * Three outcomes, not two. `degraded` is a phase that produced usable output
 * by a worse route — katana died and browser-native discovery took over. It
 * matters because it is the difference between "we found 40 URLs" and "we
 * found 40 URLs and would have found more". Both are recorded in
 * `session.json` and both mark the scan `partial`, because §10C.6 will not
 * let a degraded run claim complete coverage.
 */

/** The §9.3 lifecycle, in order. */
export const PHASES = ["policy", "discovery", "browsing", "collection", "export"] as const;

export type PhaseName = (typeof PHASES)[number];

export type PhaseStatus = "ok" | "degraded" | "failed" | "skipped";

export interface PhaseOutcome {
  readonly phase: PhaseName;
  readonly status: PhaseStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Why it is not `ok`. Required for every non-ok status. */
  readonly detail?: string | undefined;
  /** What the user can do about it — never a suggestion to circumvent (§7.3). */
  readonly remedy?: string | undefined;
}

/**
 * Phases whose failure stops the scan.
 *
 * Deliberately a set of one. Adding to it is a decision to make some class
 * of failure produce no output at all, which needs an argument each time.
 */
export const FATAL_PHASES: ReadonlySet<PhaseName> = new Set<PhaseName>(["policy"]);

export function isFatal(phase: PhaseName): boolean {
  return FATAL_PHASES.has(phase);
}

/** A phase that did not finish cleanly makes the whole scan `partial`. */
export function completenessFromPhases(
  outcomes: readonly PhaseOutcome[],
): "complete" | "partial" {
  return outcomes.every((outcome) => outcome.status === "ok") ? "complete" : "partial";
}

/**
 * The one-line reason a scan is partial, for the summary.
 *
 * The earliest non-ok phase wins: a discovery failure that caused a thin
 * browsing phase should be reported as the discovery failure, not as the
 * symptom two phases later.
 */
export function primaryDegradation(
  outcomes: readonly PhaseOutcome[],
): PhaseOutcome | undefined {
  return outcomes.find((outcome) => outcome.status !== "ok" && outcome.status !== "skipped");
}
