/**
 * API sequences — build plan §17, §17A.3; dev plan BR-M2-13.
 *
 * An inventory says *what* endpoints exist. A sequence says what order they
 * happen in, which is most of what makes an API surface attackable: that
 * `POST /api/order` follows `POST /api/order/validate` is the difference
 * between a list of endpoints and a flow someone can try to skip a step of.
 *
 * ## Application traffic only
 *
 * §17A.3. An analytics beacon between two checkout calls is not step 3 of
 * checkout. Left in, it pollutes every sequence, invents adjacency where
 * there is none, and — once V4 arrives — spends scarce model context
 * describing a Google Analytics ping.
 *
 * ## A sequence is not yet a workflow
 *
 * This groups by *page and navigation*, which is a mechanical fact. Deciding
 * that six of these calls are "the checkout workflow" is §18's job in M3,
 * with confidence scoring and the false-positive controls that go with it.
 * Calling this a workflow now would be claiming a judgment nothing has made.
 */
import type { ApiModel, ApiObject, ApiObservation } from "./model.js";
import type { Relationship } from "./relationships.js";

export interface SequencePosition {
  /** 1-based, as §17's example numbers them. */
  readonly step: number;
  readonly api_id: string;
  readonly method: string;
  readonly url: string;
  /** Envelope sequence of the request — the ordering authority (§13.2). */
  readonly sequence: number;
  readonly eventId: string;
  readonly status?: number | undefined;

  /** §17: each position retains its neighbours. */
  readonly previous: readonly string[];
  readonly next: readonly string[];

  readonly initiator?:
    { readonly type: string; readonly script?: string | undefined } | undefined;
  readonly caused_by: readonly Relationship[];
  readonly depends_on: readonly Relationship[];

  readonly page?: string | undefined;
  readonly navigationId?: string | undefined;
  readonly interactionId?: string | undefined;
  readonly authContext: string;

  /**
   * Requests in flight at the same time as this one.
   *
   * §15 and §35B.4: without it, concurrent requests read as a dependency
   * chain — "B needs A" when they simply both fired. That is the single most
   * misleading thing an API model can say, because a reader will try to
   * exploit an ordering that was never required.
   */
  readonly parallel_with: readonly string[];
}

export interface ApiSequence {
  readonly sequence_id: string;
  /** The page and navigation this run of calls belongs to. */
  readonly page?: string | undefined;
  readonly navigationId?: string | undefined;
  readonly authContext: string;
  readonly positions: readonly SequencePosition[];
  /** Distinct endpoints involved. A sequence of one is usually not a flow. */
  readonly distinctApis: number;
}

export interface SequenceModel {
  readonly sequences: readonly ApiSequence[];
  /** Observations left out, by why. Reported, never silently dropped (§45). */
  readonly excluded: Readonly<Record<string, number>>;
}

/**
 * Whether two requests were in flight at the same time.
 *
 * Exact, not a window. Each observation carries the envelope sequence of its
 * request and of its response, so "concurrent" means what it says: the
 * intervals overlap. An earlier version used a fixed window of two
 * envelopes and marked plainly sequential calls as parallel, because a
 * request and its response occupy two slots — so `GET /a` and `GET /b`, one
 * strictly after the other, landed two apart.
 *
 * Envelope sequence rather than timestamps because the log's order is the
 * ordering authority (§13.2); two requests issued in the same tick can carry
 * timestamps a millisecond apart or identical ones depending on load.
 */
function overlaps(a: ApiObservation, b: ApiObservation): boolean {
  return a.sequence < b.responseSequence && b.sequence < a.responseSequence;
}

export interface BuildSequencesOptions {
  /**
   * Break a sequence when this many envelopes pass with no application call.
   *
   * A page that sits idle for a while and then makes a second, unrelated
   * call has made two sequences, not one long one. Without a gap rule, every
   * call on a long-lived single-page application ends up in one sequence
   * that describes nothing.
   */
  readonly gapThreshold?: number | undefined;
}

const DEFAULT_GAP = 40;

interface Flat {
  readonly observation: ApiObservation;
  readonly api: ApiObject;
}

/**
 * Build sequences from an API model.
 *
 * Takes the model rather than the raw log: the model has already settled
 * identity, role and causality, and doing any of that twice is how two parts
 * of a report come to disagree.
 */
export function buildSequences(
  model: ApiModel,
  options: BuildSequencesOptions = {},
): SequenceModel {
  const gapThreshold = options.gapThreshold ?? DEFAULT_GAP;
  const excluded: Record<string, number> = {};

  const flat: Flat[] = [];
  for (const api of model.apis) {
    if (api.role !== "application_api") {
      // §17A.3. The model may have been built with a wider role filter; a
      // sequence is application traffic by definition.
      excluded[api.role] = (excluded[api.role] ?? 0) + api.observations.length;
      continue;
    }
    for (const observation of api.observations) flat.push({ observation, api });
  }

  // Envelope order, which is the ordering authority.
  flat.sort((a, b) => a.observation.sequence - b.observation.sequence);

  const groups: Flat[][] = [];
  let current: Flat[] = [];
  let lastSequence: number | undefined;

  for (const entry of flat) {
    // Page as well as navigation id: a log from a source that does not stamp
    // navigation ids would otherwise put a whole scan in one sequence, which
    // is the shape that describes nothing.
    const head = current[0]?.observation;
    const sameContext =
      head === undefined ||
      (head.navigationId === entry.observation.navigationId &&
        head.page === entry.observation.page &&
        head.authContext === entry.observation.authContext);
    const withinGap =
      lastSequence === undefined || entry.observation.sequence - lastSequence <= gapThreshold;

    if (!sameContext || !withinGap) {
      if (current.length > 0) groups.push(current);
      current = [];
    }
    current.push(entry);
    lastSequence = entry.observation.sequence;
  }
  if (current.length > 0) groups.push(current);

  const sequences = groups.map((group, index): ApiSequence => {
    const first = group[0] as Flat;

    const positions = group.map((entry, position): SequencePosition => {
      const before = group[position - 1];
      const after = group[position + 1];

      // Anything issued within the window, either side. Both directions,
      // because concurrency has no order — treating only the later one as
      // parallel would reintroduce the sequencing this exists to deny.
      const parallel = group
        .filter(
          (other, otherIndex) =>
            otherIndex !== position && overlaps(entry.observation, other.observation),
        )
        .map((other) => other.api.api_id);

      return {
        step: position + 1,
        api_id: entry.api.api_id,
        method: entry.api.method,
        url: entry.api.url,
        sequence: entry.observation.sequence,
        eventId: entry.observation.eventId,
        ...(entry.observation.status === undefined ? {} : { status: entry.observation.status }),
        previous: before === undefined ? [] : [before.api.api_id],
        next: after === undefined ? [] : [after.api.api_id],
        ...(entry.observation.initiator === undefined
          ? {}
          : {
              initiator: {
                type: entry.observation.initiator.type,
                ...(entry.observation.initiator.scripts[0] === undefined
                  ? {}
                  : { script: entry.observation.initiator.scripts[0] }),
              },
            }),
        caused_by: entry.api.caused_by,
        depends_on: entry.api.depends_on,
        ...(entry.observation.page === undefined ? {} : { page: entry.observation.page }),
        ...(entry.observation.navigationId === undefined
          ? {}
          : { navigationId: entry.observation.navigationId }),
        ...(entry.observation.interactionId === undefined
          ? {}
          : { interactionId: entry.observation.interactionId }),
        authContext: entry.observation.authContext,
        parallel_with: [...new Set(parallel)].sort(),
      };
    });

    return {
      sequence_id: `seq_${String(index + 1).padStart(4, "0")}`,
      ...(first.observation.page === undefined ? {} : { page: first.observation.page }),
      ...(first.observation.navigationId === undefined
        ? {}
        : { navigationId: first.observation.navigationId }),
      authContext: first.observation.authContext,
      positions,
      distinctApis: new Set(group.map((entry) => entry.api.api_id)).size,
    };
  });

  return { sequences, excluded };
}

/**
 * Sequences worth reporting as flows.
 *
 * A single call is not a sequence, and neither is the same endpoint polled
 * six times. `distinctApis` is the filter, and it is offered rather than
 * applied: the full set stays available, because "this page made one call"
 * is still a fact about the page.
 */
export function meaningfulSequences(
  model: SequenceModel,
  minimumDistinct = 2,
): readonly ApiSequence[] {
  return model.sequences.filter((sequence) => sequence.distinctApis >= minimumDistinct);
}
