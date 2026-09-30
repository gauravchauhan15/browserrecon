/**
 * @browserrecon/coverage — measurable, explainable coverage.
 *
 * §10C's opening line is the whole brief: optimise for "measurable,
 * explainable coverage, not a false promise of 100% discovery." The score is
 * capped below 1 because a scan cannot speak for what it never discovered,
 * every gap carries a typed reason and a response, and the caveat travels on
 * the report rather than with whoever renders it.
 */
export const PACKAGE_NAME = "@browserrecon/coverage" as const;

export { COVERAGE_CAVEAT, DIMENSIONS, REACHED, STATUSES, buildCoverage } from "./dimensions.js";
export type {
  BuildCoverageInput,
  CoverageItem,
  CoverageReport,
  CoverageStatus,
  Dimension,
  DimensionCoverage,
} from "./dimensions.js";

export {
  DEFAULT_SCORE_WEIGHTS,
  MAXIMUM_SCORE,
  SCORE_PROVENANCE,
  describe,
  scoreCoverage,
} from "./score.js";
export type { CoverageScore, ScoreComponent, ScoreInput, ScoreWeights } from "./score.js";

export {
  GAP_REASONS,
  GAP_TYPES,
  NOT_NAVIGABLE_NOTE,
  REMEDIES,
  actionable,
  buildGapQueue,
  byReason,
  prioritise,
} from "./gaps.js";
export type { CoverageGap, GapInput, GapPriority, GapReason, GapType } from "./gaps.js";

export { PROBE_METHODS, PROBE_OUTCOMES, classifyProbe, planProbes } from "./liveness.js";
export type {
  PlanProbesInput,
  ProbeMethod,
  ProbeOutcome,
  ProbePlan,
  ProbePlanResult,
  ProbeVerdict,
} from "./liveness.js";

export { buildDifferential, forReview } from "./differential.js";
export type {
  DifferentialEntry,
  DifferentialInput,
  RoleObservation,
  RoleOutcome,
} from "./differential.js";
