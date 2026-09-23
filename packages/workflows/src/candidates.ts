/**
 * Workflow candidates — build plan §18.1; dev plan BR-M3-01, BR-M3-02.
 *
 * §18.1 opens by calling this "the highest-risk deterministic component in
 * BrowserRecon — nothing off-the-shelf does it well, and everything
 * downstream inherits its errors." So the six construction steps are
 * implemented in order, named after the plan's own numbering, and each one
 * says which failure it is there to prevent.
 *
 * ## Nothing is dropped
 *
 * Candidates below the confidence floor are exported marked, never removed.
 * §18.1: "dropped candidates cannot be reviewed, and §10C's coverage
 * accounting needs to know they existed." A tool that silently discards its
 * uncertain answers looks more confident than it is.
 *
 * ## A candidate is not a workflow
 *
 * It is a segment of application traffic with evidence attached and a score
 * saying how much. Naming it "the checkout workflow" is §18.2's job, and
 * §18.2 is explicit that the model "may rename, group and explain
 * candidates; it may not create, delete or re-cut them."
 */
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  type ConfidenceWeights,
  type WorkflowThresholds,
} from "./config.js";
import {
  SIGNAL_STRENGTH,
  detectSignals,
  strongestAt,
  type ApiEvent,
  type BoundarySignal,
  type DetectInput,
} from "./signals.js";

export interface WorkflowCandidate {
  readonly workflow_id: string;
  readonly events: readonly ApiEvent[];
  /** The signal that opened it, absent for the first segment of a scan. */
  readonly startedBy?: BoundarySignal | undefined;
  /** The signal that closed it, absent for the last. */
  readonly endedBy?: BoundarySignal | undefined;
  readonly confidence: number;
  /** Every factor that moved the score, with its contribution. */
  readonly evidence: readonly { readonly factor: string; readonly weight: number }[];
  /** Below the floor. Exported anyway — see the module note. */
  readonly lowConfidence: boolean;
  readonly authContext: string;
  /** Route templates touched, deduplicated, in first-seen order. */
  readonly routes: readonly string[];
  /** Interactions attributable to this segment. */
  readonly interactions: readonly string[];
  /** Set when a rule cut this candidate short, with which rule. */
  readonly truncatedBy?: string | undefined;
}

export interface WorkflowModel {
  readonly candidates: readonly WorkflowCandidate[];
  /** Segments discarded at step 5, counted by why. Never silent (§45). */
  readonly discarded: Readonly<Record<string, number>>;
  readonly signals: readonly BoundarySignal[];
}

export interface BuildInput extends Omit<DetectInput, "thresholds"> {
  readonly thresholds?: Partial<WorkflowThresholds> | undefined;
  readonly weights?: Partial<ConfidenceWeights> | undefined;
  /** Observed state transitions, by the sequence they occurred at. */
  readonly stateTransitions?: readonly number[] | undefined;
}

/** A segment under construction, before it earns an id. */
interface Segment {
  events: ApiEvent[];
  startedBy?: BoundarySignal | undefined;
  endedBy?: BoundarySignal | undefined;
  truncatedBy?: string | undefined;
}

/**
 * A depends_on edge crossing from one segment into the next.
 *
 * The unambiguous join: the second segment needed something the first
 * produced, which makes them one piece of work however many navigations
 * happened in between.
 */
function dependencyCrosses(left: Segment, right: Segment): boolean {
  const leftIds = new Set(left.events.map((event) => event.apiId));
  return right.events.some((event) => event.dependsOn.some((target) => leftIds.has(target)));
}

/**
 * Whether to merge two segments a strong signal separated — step 3.
 *
 * **Strict, and asymmetrically so.** §18.1 says "merge adjacent segments when
 * they share an initiator chain or a depends_on edge", and the obvious
 * reading of "share an initiator chain" — the same script file — is wrong in
 * a way that shows up immediately on any real application: a single-bundle
 * app initiates *every* request from `app.js`, so every segment shares an
 * initiator and the whole scan merges into one candidate. That is §18.1's own
 * named "one giant SPA workflow" failure mode, produced by the step meant to
 * improve things.
 *
 * So the initiator has to match at the *call site* — script and line — which
 * is what "the same chain" has to mean for the rule to say anything. A
 * dependency edge merges on its own.
 *
 * Erring toward not merging is the cheap direction: several candidates
 * describing one flow is something a reader can see and join, while one
 * candidate hiding five flows is not.
 */
function shouldMerge(left: Segment, right: Segment): boolean {
  if (dependencyCrosses(left, right)) return true;

  const frames = new Set(
    left.events.map((event) => event.initiatorFrame).filter((frame) => frame !== undefined),
  );
  return right.events.some(
    (event) => event.initiatorFrame !== undefined && frames.has(event.initiatorFrame),
  );
}

/**
 * Whether a medium signal should be ignored — step 4.
 *
 * **Lenient, and deliberately the opposite of `shouldMerge`.** The two steps
 * carry opposite risks: step 3 is deciding whether to rejoin something a
 * strong signal separated, where over-merging destroys the boundary; step 4
 * is deciding whether to break something nothing has yet separated, where
 * over-splitting turns one flow into fragments too small to be workflows at
 * all — and step 5 then discards them.
 *
 * So here the coarser signal is enough: the same bundle driving both sides
 * is reason to leave a medium signal alone.
 */
function joinedAcross(left: Segment, right: Segment): boolean {
  if (dependencyCrosses(left, right)) return true;

  const scripts = new Set(
    left.events.map((event) => event.initiatorScript).filter((script) => script !== undefined),
  );
  return right.events.some(
    (event) => event.initiatorScript !== undefined && scripts.has(event.initiatorScript),
  );
}

export function buildWorkflowCandidates(input: BuildInput): WorkflowModel {
  const thresholds: WorkflowThresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const weights: ConfidenceWeights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const discarded: Record<string, number> = {};

  const signals = detectSignals({
    apiEvents: input.apiEvents,
    events: input.events,
    thresholds,
  });
  const byPoint = strongestAt(signals);
  const stateAt = new Set(input.stateTransitions ?? []);

  // --- Step 1: the application_api stream only, in sequence order ----------
  // §17A.3. The caller has already filtered; sorting here is what makes the
  // rest of this depend on nothing but the log's own ordering authority.
  const stream = [...input.apiEvents].sort((a, b) => a.sequence - b.sequence);

  // --- Step 2: cut wherever a strong signal occurs -------------------------
  let segments: Segment[] = [];
  let current: Segment = { events: [] };

  for (const event of stream) {
    // The strongest signal at or before this event but after the previous
    // one — a navigation happens between requests, not on one.
    const opening = [...byPoint.values()].find(
      (signal) =>
        SIGNAL_STRENGTH[signal.kind] === "strong" &&
        signal.sequence <= event.sequence &&
        signal.sequence > (current.events.at(-1)?.sequence ?? -1),
    );

    if (opening !== undefined && current.events.length > 0) {
      current.endedBy = opening;
      segments.push(current);
      current = { events: [], startedBy: opening };
    }

    current.events.push(event);

    // The guard against §18.1's "one giant workflow" failure mode. A
    // candidate that reaches this is cut and says so, rather than becoming a
    // thousand-step object nobody reads.
    if (current.events.length >= thresholds.maximumEvents) {
      current.truncatedBy = `reached the ${thresholds.maximumEvents}-event ceiling`;
      segments.push(current);
      current = { events: [] };
    }
  }
  if (current.events.length > 0) segments.push(current);

  // --- Step 3: merge adjacent segments joined by evidence ------------------
  // "a single workflow often spans more than one navigation" — a checkout
  // that navigates between steps is one piece of work, and cutting it at
  // every navigation would produce five candidates describing one flow.
  const merged: Segment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous !== undefined && shouldMerge(previous, segment)) {
      previous.events.push(...segment.events);
      previous.endedBy = segment.endedBy;
      continue;
    }
    merged.push(segment);
  }
  segments = merged;

  // --- Step 4: split on a medium signal with nothing joining the sides -----
  const split: Segment[] = [];
  for (const segment of segments) {
    let head: Segment = {
      events: [],
      ...(segment.startedBy === undefined ? {} : { startedBy: segment.startedBy }),
    };

    for (const event of segment.events) {
      const signal = byPoint.get(event.sequence);
      const isMedium = signal !== undefined && SIGNAL_STRENGTH[signal.kind] === "medium";

      if (isMedium && head.events.length > 0) {
        const tail: Segment = { events: [event] };
        // Only split where nothing joins the two sides. A medium signal
        // inside one piece of work — the second fetch of a checkout — is
        // evidence about the work, not a boundary in it.
        if (!joinedAcross(head, tail)) {
          head.endedBy = signal;
          split.push(head);
          head = { events: [event], startedBy: signal };
          continue;
        }
      }
      head.events.push(event);
    }

    if (head.events.length > 0) {
      head.endedBy = segment.endedBy;
      if (segment.truncatedBy !== undefined) head.truncatedBy = segment.truncatedBy;
      split.push(head);
    }
  }
  segments = split;

  // --- Step 5: discard segments with no application traffic ----------------
  // "a page that only loaded assets is a visit, not a workflow."
  const kept = segments.filter((segment) => {
    if (segment.events.length === 0) {
      discarded.empty = (discarded.empty ?? 0) + 1;
      return false;
    }
    if (segment.events.length < thresholds.minimumApiEvents) {
      // One request is an action, not a workflow — two is the smallest thing
      // that can have an order. Counted, so coverage can see them.
      discarded.too_few_events = (discarded.too_few_events ?? 0) + 1;
      return false;
    }
    return true;
  });

  // --- Step 6: emit with a confidence score --------------------------------
  const shapes = new Map<string, number>();
  for (const segment of kept) {
    const shape = segment.events.map((event) => event.routeTemplate).join(">");
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }

  const candidates = kept.map((segment, index): WorkflowCandidate => {
    const shape = segment.events.map((event) => event.routeTemplate).join(">");
    const evidence: { factor: string; weight: number }[] = [];

    if (segment.startedBy !== undefined && segment.endedBy !== undefined) {
      evidence.push({
        factor: "bounded at both ends by a boundary signal",
        weight: weights.boundedBothEnds,
      });
    }

    const interactions = [
      ...new Set(
        segment.events
          .map((event) => event.interactionId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (interactions.length > 0) {
      evidence.push({
        factor: "a user interaction is attributable to it",
        weight: weights.hasInteraction,
      });
    }

    const ids = new Set(segment.events.map((event) => event.apiId));
    if (segment.events.some((event) => event.dependsOn.some((target) => ids.has(target)))) {
      evidence.push({
        factor: "contains a depends_on edge",
        weight: weights.hasDependencyEdge,
      });
    }

    const first = segment.events[0] as ApiEvent;
    const last = segment.events[segment.events.length - 1] as ApiEvent;
    if ([...stateAt].some((at) => at >= first.sequence && at <= last.sequence)) {
      evidence.push({
        factor: "an observed state transition crosses it",
        weight: weights.hasStateTransition,
      });
    }

    if ((shapes.get(shape) ?? 0) > 1) {
      // Repetition is pattern. The same sequence of routes twice is much
      // more likely to be a real flow than a coincidence.
      evidence.push({
        factor: "the same shape was observed more than once",
        weight: weights.shapeRepeated,
      });
    }

    const idleBounded =
      segment.startedBy?.kind === "idle_period" ||
      segment.endedBy?.kind === "idle_period" ||
      segment.startedBy?.kind === "burst_after_idle" ||
      segment.endedBy?.kind === "burst_after_idle";
    if (idleBounded) {
      evidence.push({
        factor: "a boundary was inferred only from idle time",
        weight: weights.idleInferredBoundary,
      });
    }

    const unresolved = segment.events.filter(
      (event) => event.initiatorScript === undefined,
    ).length;
    if (unresolved > 0) {
      evidence.push({
        factor: `${unresolved} event(s) had no resolvable initiator`,
        weight: weights.unresolvedInitiators,
      });
    }

    const raw = evidence.reduce((total, entry) => total + entry.weight, 0);
    // Clamped, because a score outside 0..1 is not a confidence and a reader
    // will divide by it.
    const confidence = Math.max(0, Math.min(1, raw));

    return {
      workflow_id: `wf_${String(index + 1).padStart(4, "0")}`,
      events: segment.events,
      ...(segment.startedBy === undefined ? {} : { startedBy: segment.startedBy }),
      ...(segment.endedBy === undefined ? {} : { endedBy: segment.endedBy }),
      confidence,
      evidence,
      lowConfidence: confidence < thresholds.confidenceFloor,
      authContext: first.authContext,
      routes: [...new Set(segment.events.map((event) => event.routeTemplate))],
      interactions,
      ...(segment.truncatedBy === undefined ? {} : { truncatedBy: segment.truncatedBy }),
    };
  });

  return { candidates, discarded, signals };
}
