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
import { CONSUMER_FILTERS, classifyTraffic, type TrafficRole } from "@browserrecon/correlation";
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
  /**
   * Every endpoint's verdict, kept or not — §17A.1's "classify, never drop".
   *
   * The model exports what it kept; an exporter that wants to publish the
   * whole record needs to say what each request *was*, and re-running the
   * classifier at the call site would give a second opinion built from
   * different inputs. One verdict, computed once, available to both.
   */
  readonly classified: readonly {
    readonly method: string;
    /** The normalized identity, which is what a consumer can match on. */
    readonly identity: string;
    readonly role: TrafficRole;
    readonly signal: string;
  }[];
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

/**
 * Roles the model keeps by default — §17A.3's `api_inventory` consumer.
 *
 * Three, not one. The default used to be `application_api` alone, which cost
 * two whole categories of endpoint before any consumer could decide about
 * them:
 *
 *  - `auth_infrastructure`. §17A.3 lists it under workflow detection, so
 *    workflow detection was filtering for a role the model had already
 *    discarded. A login endpoint — the single most interesting POST on most
 *    applications — could not appear in the inventory at all.
 *  - `third_party_api`. An application's JSON endpoints are not all on its
 *    own registrable domain, and the ones that are not are still endpoints.
 *
 * Narrowing happens at each consumer instead, where the reason to narrow is
 * known. A model that dropped them here left no consumer the choice.
 */
/**
 * Resource types that make an unanswered request worth listing.
 *
 * `fetch` and `XMLHttpRequest` are how application code calls an endpoint.
 * A document, an image or a script that never arrived is a page or an asset
 * that failed to load, which is a different fact and not an API.
 */
const UNANSWERED_RESOURCE_TYPES: ReadonlySet<string> = new Set(["xhr", "fetch", "eventsource"]);

/** The key `classified` is indexed by — method and normalized identity. */
function identityKeyOf(method: string, identity: string): string {
  return `${method} ${identity}`;
}

const DEFAULT_ROLES: ReadonlySet<TrafficRole> = new Set<TrafficRole>(
  CONSUMER_FILTERS.api_inventory as readonly TrafficRole[],
);

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
  /** Requests the browser cancelled — counted, never listed as endpoints. */
  let abandoned = 0;
  const buckets = new Map<string, Bucket>();
  const excluded = new Map<TrafficRole, number>();
  /** Every endpoint's verdict, by identity key, in first-seen order. */
  const classified = new Map<
    string,
    { method: string; identity: string; role: TrafficRole; signal: string }
  >();
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

    // A request the browser gave up on. Removed from `pending` so the pass
    // below cannot mistake it for a call the scan cut off.
    //
    // The two look identical in a bucket keyed on responses, and they are
    // not the same fact. `fetch(beacon)` with nothing awaiting it is
    // cancelled the moment the page navigates — which is what an analytics
    // beacon *is* — while a request still in flight when the budget ends is
    // an endpoint the application called and the scan did not wait for. The
    // §18.1 control fixture caught this: admitting both put `/vendor/collect`
    // in the attack surface.
    if (envelope.type === "network_failed") {
      const failedPayload = envelope.payload as { requestId?: string; targetId?: string };
      if (failedPayload.requestId !== undefined) {
        const failedKey = `${failedPayload.targetId ?? ""}:${failedPayload.requestId}`;
        if (pending.delete(failedKey)) abandoned += 1;
      }
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

    if (!classified.has(identityKey)) {
      classified.set(identityKey, {
        method: request.payload.method,
        identity: request.url.identity,
        role: verdict.role,
        signal: verdict.signal,
      });
    }

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

  // ---- requests the scan never saw answered ------------------------------
  //
  // §45: no silent loss. Until now a request whose response never arrived
  // was counted in `unanswered` and otherwise discarded, because a bucket
  // was only ever opened on the response. That is the wrong end of the
  // exchange to key on: the *request* is the evidence that the application
  // calls an endpoint, and the response only adds a status and a shape.
  //
  // The cost was exact and reproducible. A scan of the reference application
  // called `https://data-search.apigw.example.com/v1/suggestions/`, the
  // budget
  // ended the session before the response landed, and the report's API
  // inventory read `None` — while the log it was derived from held the call.
  //
  // Narrow on purpose. Without a response there is no content type, so the
  // payload rules cannot run and `classifyTraffic` would be guessing. The
  // only ones admitted are requests the application's own code made, to a
  // host that is the application's own: `fetch`/XHR, first-party or
  // same-site. Everything else stays counted and unlisted.
  for (const unanswered of pending.values()) {
    const resourceType = unanswered.payload.resourceType?.toLowerCase() ?? "";
    if (!UNANSWERED_RESOURCE_TYPES.has(resourceType)) continue;

    // The same signals the answered path gets, minus the ones a response
    // carries. §17A.2's repeat statistics are measured over the whole log,
    // so they are available here — and leaving them out made the verdict
    // depend on whether a response happened to land before the scan ended.
    //
    // The M3 gate found it on the fixture built for exactly this: a beacon
    // fired on every page load classifies as `polling_heartbeat` while its
    // responses arrive, and the one still in flight at the end came back
    // `application_api` and reached the surface. One endpoint, two verdicts,
    // decided by a race.
    const repeat = repeats.get(
      identityKeyOf(unanswered.payload.method, unanswered.url.identity),
    );
    const verdict = classifyTraffic({
      url: unanswered.url.raw,
      method: unanswered.payload.method,
      firstPartyOrigins: options.firstPartyOrigins ?? [],
      resourceType: unanswered.payload.resourceType ?? "",
      followedInteraction: repeat?.followedInteraction ?? false,
      repeatCount: repeat?.count ?? 1,
      ...(repeat?.intervalMs === undefined ? {} : { repeatIntervalMs: repeat.intervalMs }),
      ...(repeat?.jitter === undefined ? {} : { repeatJitter: repeat.jitter }),
    });
    // Only the application's own. A third-party endpoint with no response is
    // a host that did not answer, which is not a finding about this target.
    if (verdict.role !== "application_api" && verdict.role !== "auth_infrastructure") continue;
    if (!keep.has(verdict.role)) continue;

    const identity = apiIdentity(unanswered.payload.method, unanswered.url);
    if (buckets.has(identity.key)) continue;

    const bucket: Bucket = {
      identity,
      role: verdict.role,
      observations: [
        {
          sequence: unanswered.envelope.sequence,
          // No response, so no response sequence. Pointing it at the
          // request's own would read as an exchange that completed.
          responseSequence: unanswered.envelope.sequence,
          eventId: unanswered.envelope.event_id,
          url: unanswered.url.raw,
          authContext: unanswered.envelope.auth_context,
          initiator: buildInitiatorChain(unanswered.payload.initiator),
        },
      ],
      parameters: new ParameterTally(),
      request: new ShapeBuilder(),
      response: new ShapeBuilder(),
      statuses: new Set<number>(),
      sourceEventIds: [unanswered.envelope.event_id],
      initiatingScripts: new Set<string>(),
      sawRequestBody: false,
      sawResponseBody: false,
    };
    bucket.parameters.add(queryOf(unanswered.url.raw));
    buckets.set(identity.key, bucket);
    order.push(identity.key);

    if (!classified.has(identityKeyOf(unanswered.payload.method, unanswered.url.identity))) {
      classified.set(identityKeyOf(unanswered.payload.method, unanswered.url.identity), {
        method: unanswered.payload.method,
        identity: unanswered.url.identity,
        role: verdict.role,
        signal: `${verdict.signal}; the scan ended before the response arrived`,
      });
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
    classified: [...classified.values()].sort(
      (a, b) => a.method.localeCompare(b.method) || a.identity.localeCompare(b.identity),
    ),
    excluded: [...excluded.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
    // Both kinds: the ones the browser abandoned and the ones still in
    // flight. §45 counts everything that never came back; only the second
    // kind is listed above, and only then under the narrow conditions there.
    unanswered: pending.size + abandoned,
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
