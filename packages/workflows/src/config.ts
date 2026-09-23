/**
 * Workflow detection thresholds — build plan §18.1; dev plan BR-M3-01.
 *
 * §18.1 closes with a requirement, not a suggestion: *thresholds are
 * configuration, not magic numbers buried in code, so a golden test can pin
 * them.* Every number the algorithm turns on is here, with what it means and
 * why it is that value.
 *
 * The reason is §36.2. A golden baseline records workflow boundaries and
 * confidence scores; if a threshold moves, the baseline must move with it and
 * a reviewer must see both in one diff. A constant inlined at its use site
 * changes the output of a test that does not mention it.
 */

export interface WorkflowThresholds {
  /**
   * How long after an interaction a request still counts as caused by it.
   *
   * §18.1's medium signal: "user interaction followed within N ms by >=1
   * application_api request". Two seconds covers a click that triggers a
   * fetch after a render, and stops short of the next thing the user did.
   */
  readonly interactionWindowMs: number;

  /**
   * Silence that ends a workflow.
   *
   * A weak signal, and weak for a reason: a user reading a page for eight
   * seconds has not finished a workflow, and a slow API has not either. It
   * only cuts when nothing else does.
   */
  readonly idleGapMs: number;

  /**
   * Requests close enough together to be one burst.
   *
   * §18.1's medium signal: "a burst of application_api requests after an idle
   * gap". Anything arriving within this of the last one belongs to the same
   * burst.
   */
  readonly burstWindowMs: number;

  /**
   * Below this, a candidate is exported marked `low_confidence`.
   *
   * Never dropped. §18.1: "dropped candidates cannot be reviewed, and §10C's
   * coverage accounting needs to know they existed."
   */
  readonly confidenceFloor: number;

  /**
   * Fewest application_api events a segment needs to be a candidate.
   *
   * One request is an action, not a workflow. Two is the smallest thing that
   * can have an order.
   */
  readonly minimumApiEvents: number;

  /**
   * Most events one candidate may span.
   *
   * The guard against §18.1's named failure mode: "one long SPA session with
   * no hard navigation emitted as a single giant workflow". A candidate that
   * hits this is cut and marked, rather than emitted as a thousand-step
   * object nobody can read.
   */
  readonly maximumEvents: number;
}

/**
 * Defaults.
 *
 * Chosen to be conservative in the direction that costs less. Cutting too
 * eagerly produces several small candidates, which a reader can merge by
 * eye; cutting too rarely produces one giant one, which hides everything
 * inside it and is §18.1's own named failure mode.
 */
export const DEFAULT_THRESHOLDS: WorkflowThresholds = {
  interactionWindowMs: 2_000,
  idleGapMs: 5_000,
  burstWindowMs: 1_000,
  confidenceFloor: 0.5,
  minimumApiEvents: 2,
  maximumEvents: 60,
};

/** Confidence contributions, §18.1's list with a weight each. */
export interface ConfidenceWeights {
  readonly boundedBothEnds: number;
  readonly hasInteraction: number;
  readonly hasDependencyEdge: number;
  readonly hasStateTransition: number;
  readonly shapeRepeated: number;
  readonly idleInferredBoundary: number;
  readonly unresolvedInitiators: number;
  readonly overlapsAnother: number;
}

/**
 * Weights.
 *
 * Positive evidence is worth more than negative evidence costs, deliberately:
 * a candidate with a real interaction and a real dependency edge is a
 * workflow even if one of its boundaries came from idle time. The negatives
 * express doubt, not disqualification — §18.1 keeps sub-floor candidates
 * rather than dropping them, so a score near zero still produces output.
 */
export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  boundedBothEnds: 0.25,
  hasInteraction: 0.3,
  hasDependencyEdge: 0.25,
  hasStateTransition: 0.2,
  shapeRepeated: 0.15,
  idleInferredBoundary: -0.2,
  unresolvedInitiators: -0.15,
  overlapsAnother: -0.1,
};
