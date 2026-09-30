/**
 * Multi-role differential coverage — build plan §12.4; dev plan BR-M3-09d.
 *
 * §12.4: "a single profile per scan only ever reveals one role's surface, and
 * the most valuable authorization intelligence comes from **comparing
 * roles**."
 *
 * The comparison is where the value is. `admin` reaching `/admin/users` is
 * expected; `customer` reaching it is the finding — and neither is visible
 * from one role's scan.
 *
 * ## Three rules §12.4 states, and this module holds to the third
 *
 * 1. Sequential, never concurrent, with a full browser reset between roles.
 *    That is the runner's job, not this module's.
 * 2. Budget is per-role and additive. The orchestrator's job.
 * 3. **"A reachability difference is evidence, not a finding."** That one is
 *    here, and it is the one most easily broken: "customer can reach an
 *    admin-ish endpoint" is a V6 *hypothesis with evidence*, never a
 *    confirmed vulnerability, because BrowserRecon does not verify
 *    exploitability.
 *
 * So this module emits `flaggedForReview`, not `vulnerability`. The
 * vocabulary is the guardrail: a field called `severity` would be filled in
 * by someone eventually.
 */

export type RoleOutcome = "observed" | "blocked" | "not_attempted";

/**
 * Names that suggest surface meant to be restricted.
 *
 * A heuristic, and labelled as one wherever it is used. It produces the
 * weaker of the two flags precisely because a name is not evidence: plenty
 * of applications let a customer export their own reports.
 */
const SENSITIVE_SURFACE =
  /(?:admin|internal|export|download|refund|payout|transfer|invoice|billing|audit|impersonat|config|setting|user-management|permission|role|grant|backup|restore)/i;

export interface RoleObservation {
  readonly role: string;
  readonly outcome: RoleOutcome;
  readonly status?: number | undefined;
}

export interface DifferentialEntry {
  /** Route or API this compares across roles. */
  readonly target: string;
  readonly byRole: readonly RoleObservation[];
  /**
   * What the comparison shows, in the plan's own vocabulary.
   *
   * `consistent_boundary` — higher roles in, lower roles out. Working.
   * `lower_privilege_reachable` — the reach/block split contradicts the
   *   privilege order: someone below a blocked role got in. A genuine
   *   inconsistency, and the stronger of the two flags.
   * `sensitive_surface_reached` — the boundary is consistent, but a role
   *   below the most privileged reached surface whose *name* suggests it
   *   should be restricted. §12.4's own worked example. Weaker, because it
   *   rests on a name rather than on a contradiction — an endpoint called
   *   `/api/reports/export` may be perfectly fine for a customer.
   * `uniformly_open` — everyone including anonymous. Probably public.
   * `uniformly_blocked` — nobody got in, including the highest role.
   * `insufficient_roles` — fewer than two roles attempted it.
   */
  readonly verdict:
    | "consistent_boundary"
    | "lower_privilege_reachable"
    | "sensitive_surface_reached"
    | "uniformly_open"
    | "uniformly_blocked"
    | "insufficient_roles";
  /**
   * Worth a human's attention in V6.
   *
   * Deliberately not called a finding, a vulnerability or a severity. §12.4
   * rule 3, and §20.3 says the same thing about the workflow graph.
   */
  readonly flaggedForReview: boolean;
  readonly note: string;
}

export interface DifferentialInput {
  readonly observations: readonly {
    readonly target: string;
    readonly role: string;
    readonly outcome: RoleOutcome;
    readonly status?: number | undefined;
  }[];
  /**
   * Roles from least to most privileged.
   *
   * Supplied by the user, because only they know. Guessing from names —
   * "admin sounds privileged" — would produce confident nonsense on any
   * application that names its roles differently.
   */
  readonly privilegeOrder: readonly string[];
}

export function buildDifferential(input: DifferentialInput): readonly DifferentialEntry[] {
  const byTarget = new Map<string, RoleObservation[]>();
  for (const observation of input.observations) {
    const existing = byTarget.get(observation.target) ?? [];
    existing.push({
      role: observation.role,
      outcome: observation.outcome,
      ...(observation.status === undefined ? {} : { status: observation.status }),
    });
    byTarget.set(observation.target, existing);
  }

  const rank = (role: string): number => {
    const index = input.privilegeOrder.indexOf(role);
    // A role nobody ranked sorts last, and is never treated as low-privilege
    // — calling an unknown role "lower privilege" is how a false flag gets
    // raised against a role the user never described.
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return [...byTarget.entries()]
    .map(([target, observations]): DifferentialEntry => {
      const attempted = observations.filter((o) => o.outcome !== "not_attempted");
      const sorted = [...observations].sort((a, b) => rank(a.role) - rank(b.role));

      if (attempted.length < 2) {
        return {
          target,
          byRole: sorted,
          verdict: "insufficient_roles",
          flaggedForReview: false,
          note: "fewer than two roles attempted this; there is nothing to compare",
        };
      }

      const reached = attempted.filter((o) => o.outcome === "observed");
      if (reached.length === 0) {
        return {
          target,
          byRole: sorted,
          verdict: "uniformly_blocked",
          flaggedForReview: false,
          note: "no role reached it, including the most privileged attempted",
        };
      }
      if (reached.length === attempted.length) {
        return {
          target,
          byRole: sorted,
          verdict: "uniformly_open",
          flaggedForReview: false,
          note: "every role that attempted it reached it; probably public surface",
        };
      }

      // Someone got in and someone did not. Whether that is a boundary or
      // evidence depends on which way round.
      const lowestReaching = Math.min(...reached.map((o) => rank(o.role)));
      const highestBlocked = Math.max(
        ...attempted.filter((o) => o.outcome === "blocked").map((o) => rank(o.role)),
      );

      if (lowestReaching > highestBlocked) {
        // The split matches the privilege order. Still worth a second look
        // when the surface is named like something restricted and a role
        // below the top reached it — §12.4's worked example is exactly this
        // shape, and it flags it.
        const topAttempted = Math.max(...attempted.map((observation) => rank(observation.role)));
        if (SENSITIVE_SURFACE.test(target) && lowestReaching < topAttempted) {
          const who = reached.find((o) => rank(o.role) === lowestReaching)?.role ?? "a lower role";
          return {
            target,
            byRole: sorted,
            verdict: "sensitive_surface_reached",
            flaggedForReview: true,
            note:
              `${who} reached surface whose name suggests it is restricted. The ` +
              "boundary is consistent with the privilege order, so this rests on the " +
              "name rather than on a contradiction — evidence for review, not a finding.",
          };
        }

        return {
          target,
          byRole: sorted,
          verdict: "consistent_boundary",
          flaggedForReview: false,
          note: "every role that reached it outranks every role that was blocked",
        };
      }

      const role = reached.find((o) => rank(o.role) === lowestReaching)?.role ?? "a lower role";
      return {
        target,
        byRole: sorted,
        verdict: "lower_privilege_reachable",
        // Evidence, not a finding. §12.4 rule 3: BrowserRecon does not
        // verify exploitability, so this is a V6 hypothesis with evidence
        // attached — never a confirmed vulnerability.
        flaggedForReview: true,
        note:
          `${role} reached this while a higher-privileged role was blocked. ` +
          "This is evidence for review, not a confirmed authorization flaw — " +
          "exploitability is not tested.",
      };
    })
    .sort((a, b) => a.target.localeCompare(b.target));
}

/** Entries V6 should look at. Never presented as findings. */
export function forReview(
  entries: readonly DifferentialEntry[],
): readonly DifferentialEntry[] {
  return entries.filter((entry) => entry.flaggedForReview);
}
