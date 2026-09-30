/**
 * The coverage score — build plan §10C.4, §10C.6; dev plan BR-M3-08.
 *
 * §10C.4 permits a score and constrains it twice: it is computed from
 * weighted evidence, and it "must never be generated solely by the LLM."
 * §10C.6 adds the harder constraint — it must not claim literal 100%.
 *
 * ## Why it is capped below 1
 *
 * Not as a rhetorical flourish. A scan measures *the surface it could reach*
 * under a policy, an auth state, a budget and a set of analysis limits.
 * Even a scan that reached everything it discovered has not reached what it
 * never discovered, and there is no way to know how much that is. A score of
 * 1.0 would be a claim about the unmeasured part, which is the one claim this
 * tool cannot make.
 *
 * So the ceiling is 0.95, and `describe()` says what that means rather than
 * letting a reader infer "5% broken".
 *
 * ## Why it is deterministic
 *
 * The same evidence produces the same number, every run. A score that drifted
 * would make every report a diff and every comparison meaningless — and a
 * score a model produced would drift by construction, which is what §10C.4
 * rules out.
 */
import type { CoverageReport, Dimension } from "./dimensions.js";

/** §10C.4's named evidence, with what each contributes. */
export interface ScoreWeights {
  readonly firstPartyJs: number;
  readonly runtimeApi: number;
  readonly route: number;
  readonly workflow: number;
  readonly webmcp: number;
  /** Subtracted. An unresolved barrier is surface nobody saw. */
  readonly unresolvedBarriers: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  firstPartyJs: 0.2,
  runtimeApi: 0.3,
  route: 0.2,
  workflow: 0.2,
  webmcp: 0.1,
  unresolvedBarriers: -0.15,
};

/**
 * The most this tool will ever report.
 *
 * §10C.6 forbids claiming complete coverage, and a ceiling of exactly 1 with
 * a footnote is a claim of complete coverage with a footnote.
 */
export const MAXIMUM_SCORE = 0.95;

export interface ScoreComponent {
  readonly evidence: string;
  /** The dimension's own ratio, or undefined where it found nothing. */
  readonly ratio?: number | undefined;
  readonly weight: number;
  readonly contribution: number;
}

export interface CoverageScore {
  /** 0 to MAXIMUM_SCORE. Never 1. */
  readonly score: number;
  readonly components: readonly ScoreComponent[];
  /** Dimensions that found nothing, so they scored nothing either way. */
  readonly notMeasured: readonly Dimension[];
  /** One sentence a report can print without adding a caveat of its own. */
  readonly description: string;
}

const DIMENSION_FOR: Readonly<Record<keyof Omit<ScoreWeights, "unresolvedBarriers">, Dimension>> = {
  firstPartyJs: "first_party_js",
  runtimeApi: "runtime_api",
  route: "route",
  workflow: "workflow",
  webmcp: "webmcp",
};

export interface ScoreInput {
  readonly coverage: CoverageReport;
  readonly weights?: Partial<ScoreWeights> | undefined;
}

export function scoreCoverage(input: ScoreInput): CoverageScore {
  const weights: ScoreWeights = { ...DEFAULT_SCORE_WEIGHTS, ...input.weights };
  const byDimension = new Map(input.coverage.dimensions.map((entry) => [entry.dimension, entry]));

  const components: ScoreComponent[] = [];
  const notMeasured: Dimension[] = [];
  let earned = 0;
  let available = 0;

  for (const [key, dimension] of Object.entries(DIMENSION_FOR) as [
    keyof typeof DIMENSION_FOR,
    Dimension,
  ][]) {
    const entry = byDimension.get(dimension);
    const weight = weights[key];

    if (entry === undefined || entry.ratio === undefined) {
      // A dimension with nothing in it is excluded from both sides. Scoring
      // it zero would punish a site with no WebMCP for not having any, and
      // scoring it one would reward it — both are claims about something
      // that was never measured.
      notMeasured.push(dimension);
      components.push({ evidence: dimension, weight, contribution: 0 });
      continue;
    }

    const contribution = entry.ratio * weight;
    earned += contribution;
    available += weight;
    components.push({ evidence: dimension, ratio: entry.ratio, weight, contribution });
  }

  const barriers = byDimension.get("access_barrier");
  const unresolved = (barriers?.byStatus.blocked ?? 0) + (barriers?.byStatus.unknown ?? 0);
  if (unresolved > 0 && barriers !== undefined && barriers.total > 0) {
    const penalty = weights.unresolvedBarriers * (unresolved / barriers.total);
    earned += penalty;
    components.push({
      evidence: "unresolved access barriers",
      ratio: unresolved / barriers.total,
      weight: weights.unresolvedBarriers,
      contribution: penalty,
    });
  }

  // Normalised over what was measurable, so a scan of a site with no
  // WebMCP is not permanently capped at 90%.
  const normalised = available === 0 ? 0 : earned / available;
  const score = Math.max(0, Math.min(MAXIMUM_SCORE, normalised));

  return {
    score,
    components,
    notMeasured,
    description: describe(score, notMeasured.length),
  };
}

/**
 * Say what the number means.
 *
 * Without this a reader supplies their own reading, and the obvious one —
 * "95% of the application" — is exactly the claim §10C.6 forbids.
 */
export function describe(score: number, unmeasuredDimensions = 0): string {
  const percent = Math.round(score * 100);
  const unmeasured =
    unmeasuredDimensions === 0
      ? ""
      : ` ${unmeasuredDimensions} dimension(s) found nothing to measure and are excluded.`;

  return (
    `${percent}% of the surface this scan could reach was observed or analysed. ` +
    "This is a proportion of what was reachable under the policy, session and " +
    `budget in force — not of the application.${unmeasured}`
  );
}

/** Whether a score was produced by this engine rather than a model (§10C.4). */
export const SCORE_PROVENANCE = "deterministic" as const;
