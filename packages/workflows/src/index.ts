/**
 * @browserrecon/workflows — deterministic workflow candidates.
 *
 * §18.1's algorithm, implemented step by step against a recorded event log
 * with no browser present. What it produces are *candidates* with evidence
 * and a score, not named workflows: naming is §18.2's job, and §18.2 may
 * "rename, group and explain candidates; it may not create, delete or re-cut
 * them."
 */
export const PACKAGE_NAME = "@browserrecon/workflows" as const;

export { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "./config.js";
export type { ConfidenceWeights, WorkflowThresholds } from "./config.js";

export {
  SIGNAL_KINDS,
  SIGNAL_STRENGTH,
  SIGNAL_STRENGTHS,
  detectSignals,
  strongestAt,
} from "./signals.js";
export type { ApiEvent, BoundarySignal, SignalKind, SignalStrength } from "./signals.js";

export { buildWorkflowCandidates } from "./candidates.js";
export type { BuildInput, WorkflowCandidate, WorkflowModel } from "./candidates.js";
