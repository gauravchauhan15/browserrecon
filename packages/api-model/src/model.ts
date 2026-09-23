/**
 * The API model — build plan §14, §23.2; dev plan BR-M2-01..04.
 *
 * Turns a recorded event log into the objects §23.2 specifies: one per
 * endpoint, carrying every observation of it, its initiator chains, its
 * typed relationships and its payload shapes.
 *
 * ## It takes events, not a browser
 *
 * §1.2's load-bearing rule: everything from correlation rightward must be
 * runnable against a recorded `events.jsonl` with no browser present. That
 * is what makes this testable from a literal array of envelopes, replayable
 * against last week's scan, and debuggable without reproducing a page.
 *
 * ## Only application traffic
 *
 * §17A.3. Analytics beacons, session-replay chatter and a chat widget's
 * polling are requests, and they are not the application's API. Including
 * them would put twenty endpoints nobody can attack in front of the two
 * that matter, which is the same failure as reporting eighty product pages
 * as eighty endpoints.
 *
 * The filter is applied here rather than at collection, because the event
 * store is raw by design and a scan that discarded traffic at write time
 * could never be re-analysed with better rules.
 */
import { normalizeUrl, type NormalizedUrl } from "@browserrecon/collector-network";
import { classifyTraffic, type TrafficRole } from "@browserrecon/correlation";
import type { EventEnvelope } from "@browserrecon/events";
import {
  ParameterTally,
  apiIdentity,
  type ApiIdentity,
  type ObservedParameter,
} from "./identity.js";
import { ShapeBuilder, type PayloadShape } from "./payload.js";
import { dependenciesFor, extractIdentifiers, valuesIn, type FlowSource } from "./flow.js";
import {
  buildInitiatorChain,
  reduceRelationships,
  type InitiatorChain,
  type RawInitiator,
  type Relationship,
} from "./relationships.js";

/** One time an endpoint was called. */
export interface ApiObservation {
  /** Envelope sequence of the request event — the ordering authority (§13.2). */
  readonly sequence: number;
  /**
   * Envelope sequence of the response.
   *
   * With the request sequence this gives the interval the request was in
   * flight, which is what makes "these two were concurrent" an exact
   * statement rather than a guess at a window.
   */
  readonly responseSequence: number;
  readonly eventId: string;
  readonly url: string;
  readonly status?: number | undefined;
  readonly contentType?: string | undefined;
  readonly page?: string | undefined;
  readonly navigationId?: string | undefined;
  readonly interactionId?: string | undefined;
  readonly authContext: string;
  readonly initiator: InitiatorChain;
}

export interface ApiObject {
  readonly api_id: string;
  readonly identity: ApiIdentity;
  readonly method: string;
  readonly url: string;
  readonly role: TrafficRole;
  readonly observations: readonly ApiObservation[];
  /** Statuses seen, sorted. Two different statuses is itself a signal. */
  readonly statuses: readonly number[];
  readonly parameters: readonly ObservedParameter[];
  readonly requestShape?: PayloadShape | undefined;
  readonly responseShape?: PayloadShape | undefined;
  readonly caused_by: readonly Relationship[];
  readonly depends_on: readonly Relationship[];
  /** §35B.5: every derived object traces back to observations. */
  readonly source_event_ids: readonly string[];
  readonly provenance: "observed";
}

export interface ApiModel {
  readonly apis: readonly ApiObject[];
  /** Requests excluded as non-application traffic, counted by role. */
  readonly excluded: readonly { readonly role: TrafficRole; readonly count: number }[];
  /** Requests seen but never answered when the scan ended. */
  readonly unanswered: number;
}

interface RequestPayload {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType?: string;
  readonly initiator?: RawInitiator;
  readonly targetId?: string;
  readonly postData?: string;
  readonly headers?: Record<string, string>;
}

interface ResponsePayload {
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly mimeType?: string;
  readonly targetId?: string;
  readonly headers?: Record<string, string>;
  readonly body?: { readonly text?: string };
}

interface Pending {
  readonly envelope: EventEnvelope;
  readonly payload: RequestPayload;
  readonly url: NormalizedUrl;
}

interface Bucket {
  readonly identity: ApiIdentity;
  readonly role: TrafficRole;
  readonly observations: ApiObservation[];
  readonly parameters: ParameterTally;
  readonly request: ShapeBuilder;
  readonly response: ShapeBuilder;
  readonly statuses: Set<number>;
  readonly sourceEventIds: string[];
  /** Scripts that initiated calls to this endpoint, for `caused_by`. */
  readonly initiatingScripts: Set<string>;
  sawRequestBody: boolean;
  sawResponseBody: boolean;
}

export interface BuildApiModelOptions {
  /**
   * Roles to keep. Defaults to application traffic only (§17A.3).
   *
   * Widening it is a deliberate act: a caller that wants analytics in the
   * model has to say so, rather than getting it because nobody filtered.
   */
  readonly roles?: ReadonlySet<TrafficRole> | undefined;
  /**
   * Origins the scan treats as first-party — the target and its allowed set.
   *
   * Plural because an application's API often lives on a second origin the
   * policy allowed. Passing only the target would classify its own backend
   * as third-party, which is the difference between finding the API surface
   * and reporting it as someone else's.
   */
  readonly firstPartyOrigins?: readonly string[] | undefined;
}

/**
 * Query parameters as name/value pairs.
 *
 * `NormalizedUrl` carries names only, deliberately — a value has no place in
 * a grouping key. The values are read back from the raw URL here, where the
 * tally can decide which are safe to keep an example of.
 */
function queryOf(raw: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const [name, value] of new URL(raw).searchParams) out[name] = value;
    return out;
  } catch {
    return {};
  }
}

const DEFAULT_ROLES: ReadonlySet<TrafficRole> = new Set<TrafficRole>(["application_api"]);

/**
 * Build the model from a log.
 *
 * Synchronous over an array rather than streaming: the model is a fraction
 * of the log's size and every stage needs the whole thing anyway —
 * `depends_on` cannot be settled until the last request is in. The log
 * itself is streamed off disk by the caller; this sees only what survived
 * the role filter.
 */
/**
 * How often each endpoint was called, how evenly, and whether anyone clicked.
 *
 * §17A.2's polling signal needs an interval and its jitter. The model used to
 * pass a running repeat count and nothing else, so `looksLikePolling` — which
 * returns false the moment the interval is absent — could never fire: every
 * heartbeat in every scan was filed as an application API. Its unit tests
 * passed because they hand the classifier an interval directly.
 *
 * Two things follow from measuring it here, in a pass of its own:
 *
 *  - The statistics are the endpoint's, not one call's. A running count means
 *    the first two calls classify one way and the third another, and the
 *    bucket keeps whichever verdict arrived first — so an endpoint could not
 *    become a heartbeat after its first observation however it behaved later.
 *  - Every observation of an endpoint therefore classifies identically, which
 *    is what makes the role a property of the endpoint rather than of
 *    whichever call happened to be recorded first.
 */
interface RepeatStats {
  readonly count: number;
  readonly intervalMs?: number | undefined;
  readonly jitter?: number | undefined;
  readonly followedInteraction: boolean;
}

function repeatStatistics(events: readonly EventEnvelope[]): ReadonlyMap<string, RepeatStats> {
  const times = new Map<string, number[]>();
  const clicked = new Set<string>();
  let interactionId: string | undefined;

  for (const envelope of events) {
    if (envelope.type === "navigation_committed" || envelope.type === "page_loaded") {
      interactionId = undefined;
      continue;
    }
    if (envelope.type === "interaction") {
      interactionId = (envelope.payload as { interactionId?: string }).interactionId;
      continue;
    }
    if (envelope.type !== "network_request") continue;

    const payload = envelope.payload as RequestPayload;
    const key = `${payload.method} ${normalizeUrl(payload.url).identity}`;
    const at = Date.parse(envelope.timestamp);
    times.set(key, [...(times.get(key) ?? []), Number.isNaN(at) ? 0 : at]);
    if (interactionId !== undefined) clicked.add(key);
  }

  const stats = new Map<string, RepeatStats>();
  for (const [key, samples] of times) {
    const followedInteraction = clicked.has(key);
    if (samples.length < 2) {
      stats.set(key, { count: samples.length, followedInteraction });
      continue;
    }

    const gaps: number[] = [];
    for (let index = 1; index < samples.length; index += 1) {
      gaps.push((samples[index] as number) - (samples[index - 1] as number));
    }
    const mean = gaps.reduce((total, gap) => total + gap, 0) / gaps.length;
    // Jitter is relative, so a zero mean has none to express. Requests
    // recorded within the same millisecond are a burst, not a timer, and a
    // burst has no interval for §17A.2 to reason about.
    const variance = gaps.reduce((total, gap) => total + (gap - mean) ** 2, 0) / gaps.length;
    const jitter = mean === 0 ? undefined : Math.sqrt(variance) / Math.abs(mean);

    stats.set(key, {
      count: samples.length,
      ...(mean === 0 ? {} : { intervalMs: mean, jitter }),
      followedInteraction,
    });
  }
  return stats;
}

export function buildApiModel(
  events: readonly EventEnvelope[],
  options: BuildApiModelOptions = {},
): ApiModel {
  const keep = options.roles ?? DEFAULT_ROLES;
  const pending = new Map<string, Pending>();
  const buckets = new Map<string, Bucket>();
  const excluded = new Map<TrafficRole, number>();
  // Ordered by first appearance, so api_0001 is the first endpoint the scan
  // met rather than whichever sorts first.
  const order: string[] = [];

  /** §17A.2's repeat signal, measured over the whole log before this pass. */
  const repeats = repeatStatistics(events);
  /**
   * Identifiers each response carried, and what each request carried forward.
   *
   * Values live here for the duration of the build and are never exported —
   * `depends_on` records the field that flowed, not what was in it.
   */
  const flowSources: FlowSource[] = [];
  const consumers: { apiId: string; sequence: number; candidates: readonly string[] }[] = [];
  const currentPage = {
    url: undefined as string | undefined,
    navigationId: undefined as string | undefined,
  };
  let interactionId: string | undefined;

  for (const envelope of events) {
    if (envelope.type === "navigation_committed" || envelope.type === "page_loaded") {
      const payload = envelope.payload as { url?: string };
      if (payload.url !== undefined) currentPage.url = payload.url;
      currentPage.navigationId = envelope.navigation_id;
      // A navigation ends the interaction's blast radius: a request made
      // after the page changed was not caused by a click on the old one.
      interactionId = undefined;
      continue;
    }

    if (envelope.type === "interaction") {
      // `interactionId`, the key the interaction collector actually emits.
      //
      // This read `interaction_id` and fell back to the envelope's event id,
      // which meant it never once produced a real interaction id — and the
      // field looked populated, so nothing noticed. Every unit test passed
      // because they built events with the invented key. The M2 gate caught
      // it the first time a real scan produced an interaction.
      //
      // No fallback now. An interaction event carries an interaction id or
      // it carries nothing; a plausible wrong value is worse than an absent
      // one, because only one of them gets investigated.
      const payload = envelope.payload as { interactionId?: string };
      interactionId = payload.interactionId;
      continue;
    }

    if (envelope.type === "network_request") {
      const payload = envelope.payload as RequestPayload;
      const url = normalizeUrl(payload.url);
      pending.set(`${payload.targetId ?? ""}:${payload.requestId}`, { envelope, payload, url });
      continue;
    }

    if (envelope.type !== "network_response") continue;

    const payload = envelope.payload as ResponsePayload;
    const key = `${payload.targetId ?? ""}:${payload.requestId}`;
    const request = pending.get(key);
    if (request === undefined) continue;
    pending.delete(key);

    const identityKey = `${request.payload.method} ${request.url.identity}`;
    const repeat = repeats.get(identityKey);

    const verdict = classifyTraffic({
      url: request.url.raw,
      method: request.payload.method,
      firstPartyOrigins: options.firstPartyOrigins ?? [],
      ...(request.payload.resourceType === undefined
        ? {}
        : { resourceType: request.payload.resourceType }),
      ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
      ...(payload.status === undefined ? {} : { status: payload.status }),
      ...(request.payload.initiator?.type === undefined
        ? {}
        : { initiatorType: request.payload.initiator.type }),
      // §17A.2's strongest structural signal: traffic a person caused looks
      // different from traffic a timer caused. We know which, so we say.
      // Taken over every call to this endpoint: one click anywhere in the
      // scan is enough to say a person can cause it.
      followedInteraction: repeat?.followedInteraction ?? interactionId !== undefined,
      repeatCount: repeat?.count ?? 1,
      ...(repeat?.intervalMs === undefined ? {} : { repeatIntervalMs: repeat.intervalMs }),
      ...(repeat?.jitter === undefined ? {} : { repeatJitter: repeat.jitter }),
    });

    if (!keep.has(verdict.role)) {
      excluded.set(verdict.role, (excluded.get(verdict.role) ?? 0) + 1);
      continue;
    }

    const identity = apiIdentity(request.payload.method, request.url);
    let bucket = buckets.get(identity.key);
    if (bucket === undefined) {
      bucket = {
        identity,
        role: verdict.role,
        observations: [],
        parameters: new ParameterTally(),
        request: new ShapeBuilder(),
        response: new ShapeBuilder(),
        statuses: new Set<number>(),
        sourceEventIds: [],
        initiatingScripts: new Set<string>(),
        sawRequestBody: false,
        sawResponseBody: false,
      };
      buckets.set(identity.key, bucket);
      order.push(identity.key);
    }

    const chain = buildInitiatorChain(request.payload.initiator);
    for (const script of chain.scripts) bucket.initiatingScripts.add(script);

    bucket.observations.push({
      sequence: request.envelope.sequence,
      responseSequence: envelope.sequence,
      eventId: request.envelope.event_id,
      url: request.url.raw,
      status: payload.status,
      ...(payload.mimeType === undefined ? {} : { contentType: payload.mimeType }),
      ...(currentPage.url === undefined ? {} : { page: currentPage.url }),
      ...(currentPage.navigationId === undefined
        ? {}
        : { navigationId: currentPage.navigationId }),
      ...(interactionId === undefined ? {} : { interactionId }),
      authContext: request.envelope.auth_context,
      initiator: chain,
    });

    bucket.statuses.add(payload.status);
    bucket.parameters.add(queryOf(request.url.raw));
    bucket.sourceEventIds.push(request.envelope.event_id, envelope.event_id);

    if (request.payload.postData !== undefined) {
      bucket.sawRequestBody = true;
      bucket.request.add(
        request.payload.postData,
        request.payload.headers?.["content-type"] ?? undefined,
      );
    }
    if (payload.body?.text !== undefined) {
      bucket.sawResponseBody = true;
      bucket.response.add(payload.body.text, payload.mimeType);
    }

    // §15's structural alternative to guessing from adjacency. Recorded per
    // observation rather than per endpoint, because which call produced a
    // value is what makes the edge checkable.
    consumers.push({
      apiId: identity.key,
      sequence: request.envelope.sequence,
      candidates: valuesIn(request.url.raw, request.payload.postData),
    });
    if (payload.body?.text !== undefined && payload.body.text.length <= 256 * 1024) {
      const values = extractIdentifiers(payload.body.text);
      if (values.length > 0) {
        flowSources.push({ apiId: identity.key, sequence: envelope.sequence, values });
      }
    }
  }

  // Identity keys are stable within a build; api_ids are assigned by first
  // appearance, so the edges are translated after numbering rather than
  // during, when the numbers do not exist yet.
  const idForKey = new Map(
    order.map((key, index) => [key, `api_${String(index + 1).padStart(4, "0")}`]),
  );
  const named = (key: string): string => idForKey.get(key) ?? key;

  const dependsOnByKey = new Map<string, Relationship[]>();
  for (const consumer of consumers) {
    const edges = dependenciesFor(
      { apiId: consumer.apiId, sequence: consumer.sequence, candidates: consumer.candidates },
      flowSources,
    ).map((edge) => ({
      ...edge,
      target: `api:${named(edge.target.replace(/^api:/, ""))}`,
      basis: edge.basis.replace(
        /from ([^']+)'s response/,
        (_match, key: string) => `from ${named(key)}'s response`,
      ),
    }));
    if (edges.length === 0) continue;
    dependsOnByKey.set(consumer.apiId, [
      ...(dependsOnByKey.get(consumer.apiId) ?? []),
      ...edges,
    ]);
  }

  const apis = order.map((key, index): ApiObject => {
    const bucket = buckets.get(key) as Bucket;
    const first = bucket.observations[0] as ApiObservation;

    return {
      api_id: `api_${String(index + 1).padStart(4, "0")}`,
      identity: bucket.identity,
      method: bucket.identity.method,
      url: `${bucket.identity.origin}${bucket.identity.pathTemplate}`,
      role: bucket.role,
      observations: bucket.observations,
      statuses: [...bucket.statuses].sort((a, b) => a - b),
      parameters: bucket.parameters.snapshot(),
      ...(bucket.sawRequestBody ? { requestShape: bucket.request.snapshot() } : {}),
      ...(bucket.sawResponseBody ? { responseShape: bucket.response.snapshot() } : {}),
      caused_by: reduceRelationships(causedBy(bucket, first)),
      depends_on: reduceRelationships(dependsOnByKey.get(key) ?? []),
      source_event_ids: bucket.sourceEventIds,
      provenance: "observed",
    };
  });

  return {
    apis,
    excluded: [...excluded.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
    unanswered: pending.size,
  };
}

/**
 * Edges an endpoint's own observations justify.
 *
 * Only two kinds are produced here, and neither is temporal: the script
 * Chrome named as initiator, and the interaction the request followed. §15
 * forbids inferring causality from adjacency, so "the request before this
 * one" produces nothing. Cross-endpoint dependency inference is BR-M2-13's
 * job, where a sequence gives it evidence to work from.
 */
function causedBy(bucket: Bucket, first: ApiObservation): Relationship[] {
  const edges: Relationship[] = [];

  for (const script of bucket.initiatingScripts) {
    edges.push({
      target: `script:${script}`,
      kind: "direct",
      basis: "named by Chrome as the request's initiator",
    });
  }

  if (first.interactionId !== undefined) {
    edges.push({
      target: `interaction:${first.interactionId}`,
      kind: "direct",
      basis: "the request was made while this interaction was the most recent one",
    });
  }

  return edges;
}
