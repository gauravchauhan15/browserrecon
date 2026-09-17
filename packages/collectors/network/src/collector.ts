/**
 * The network collector — build plan §13, §14, §32.2; dev plan BR-M1-06.
 *
 * Telemetry reports three separate events for one request: it started, it
 * answered, it failed. Every consumer downstream wants the *request* — one
 * object with what was asked and what came back. Building that join in each
 * consumer would mean each getting it subtly differently, so it happens once,
 * here.
 *
 * §32.2 — correlation is separate from collection — draws the line this stays
 * behind. Joining a response to its own request by CDP request id is not
 * correlation; it is reassembling one thing that arrived in pieces. Deciding
 * that one request *caused* another is correlation, and that is §15's job.
 *
 * ## It keeps what it was given
 *
 * Every observation carries the raw URL and Chrome's own error string
 * alongside the normalized identity and the typed reason. Normalization is an
 * index, not a replacement: the moment a consumer needs to know whether the
 * path was `/Admin` or `/admin`, the answer has to still be there (§37.2).
 */
import type { EventBus, EventEnvelope, Unsubscribe } from "@browserrecon/events";
import { classifyFailure, type ClassifiedFailure } from "./failures.js";
import { normalizeUrl, type NormalizedUrl } from "./url.js";

/** The subset of a telemetry payload this collector reads. */
interface RequestPayload {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType?: string;
  readonly initiator?: { readonly type: string; readonly url?: string };
  readonly frameId?: string;
  readonly hasPostData?: boolean;
  readonly targetId?: string;
}

interface ResponsePayload {
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly mimeType?: string;
  readonly remoteIpAddress?: string;
  readonly encodedDataLength?: number;
  readonly body?: { readonly text?: string; readonly skipped?: string };
}

interface FailedPayload {
  readonly requestId: string;
  readonly url?: string;
  readonly errorText: string;
  readonly canceled?: boolean;
}

/** One request and whatever became of it. */
export interface NetworkObservation {
  readonly requestId: string;
  /** Envelope sequence of the request event — the ordering authority (§13.2). */
  readonly sequence: number;
  readonly method: string;
  readonly url: NormalizedUrl;
  readonly resourceType?: string | undefined;
  readonly initiatorType?: string | undefined;
  readonly initiatorUrl?: string | undefined;
  readonly frameId?: string | undefined;
  readonly hasPostData: boolean;
  /** Present once the response arrived. */
  readonly status?: number | undefined;
  readonly mimeType?: string | undefined;
  readonly remoteIpAddress?: string | undefined;
  readonly responseBytes?: number | undefined;
  /** Whether a response body was kept, and why not when it was not. */
  readonly bodyCaptured?: boolean | undefined;
  readonly bodySkipped?: string | undefined;
  /** Present when the request failed instead. */
  readonly failure?: ClassifiedFailure | undefined;
  /**
   * The final URL, when the response came back from somewhere else.
   *
   * A redirect the browser followed shows up as a response whose URL differs
   * from the request's. Recording it here is what lets a later stage notice a
   * request that left the origin it was aimed at.
   */
  readonly respondedFrom?: NormalizedUrl | undefined;
}

/** Everything seen against one origin. */
export interface OriginGroup {
  readonly origin: string;
  /** Distinct endpoint identities, each with the observations against it. */
  readonly endpoints: ReadonlyMap<string, readonly NetworkObservation[]>;
  readonly requests: number;
  readonly failures: number;
  /** Methods seen, sorted, so a summary reads the same every run. */
  readonly methods: readonly string[];
  /** Status codes seen, sorted. */
  readonly statuses: readonly number[];
}

export interface NetworkModel {
  /** Every observation, in the order its request was made. */
  readonly observations: readonly NetworkObservation[];
  /** Grouped by origin, origins sorted so output is reproducible. */
  readonly origins: readonly OriginGroup[];
  /** Requests that started but never finished when the scan ended. */
  readonly inFlight: number;
}

export interface NetworkCollector {
  /** The model as it stands. Safe to read at any point during a scan. */
  readonly model: NetworkModel;
  /** Stop consuming. Safe to call twice. */
  stop(): void;
}

/**
 * Consume a bus and build the model.
 *
 * Subscribing rather than being handed events keeps this independent of who
 * produced them: the same collector works against a live scan, a replayed
 * event log, or a fixture that publishes by hand — which is what makes §36.2's
 * golden tests possible without a browser.
 */
export function collectNetwork(bus: EventBus): NetworkCollector {
  /** Keyed by target and request id — CDP ids are unique only within a target. */
  const byKey = new Map<string, NetworkObservation>();
  /** Insertion order, which is request order. */
  const order: string[] = [];
  let stopped = false;

  const key = (targetId: string | undefined, requestId: string): string =>
    `${targetId ?? "-"}:${requestId}`;

  const unsubscribe: Unsubscribe = bus.subscribe(
    (envelope: EventEnvelope) => {
      if (envelope.type === "network_request") {
        const payload = envelope.payload as RequestPayload;
        const id = key(payload.targetId, payload.requestId);
        if (byKey.has(id)) return;

        byKey.set(id, {
          requestId: payload.requestId,
          sequence: envelope.sequence,
          method: payload.method,
          url: normalizeUrl(payload.url),
          ...(payload.resourceType === undefined ? {} : { resourceType: payload.resourceType }),
          ...(payload.initiator?.type === undefined
            ? {}
            : { initiatorType: payload.initiator.type }),
          ...(payload.initiator?.url === undefined
            ? {}
            : { initiatorUrl: payload.initiator.url }),
          ...(payload.frameId === undefined ? {} : { frameId: payload.frameId }),
          hasPostData: payload.hasPostData === true,
        });
        order.push(id);
        return;
      }

      if (envelope.type === "network_response") {
        const payload = envelope.payload as ResponsePayload & { targetId?: string };
        const id = key(payload.targetId, payload.requestId);
        const existing = byKey.get(id);
        // A response with no request means telemetry attached mid-flight. The
        // telemetry layer already counts those; dropping it here rather than
        // inventing a half-observation keeps the model honest.
        if (existing === undefined) return;

        const responded = normalizeUrl(payload.url);
        byKey.set(id, {
          ...existing,
          status: payload.status,
          ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
          ...(payload.remoteIpAddress === undefined
            ? {}
            : { remoteIpAddress: payload.remoteIpAddress }),
          ...(payload.encodedDataLength === undefined
            ? {}
            : { responseBytes: payload.encodedDataLength }),
          bodyCaptured: payload.body?.text !== undefined,
          ...(payload.body?.skipped === undefined ? {} : { bodySkipped: payload.body.skipped }),
          ...(responded.identity === existing.url.identity ? {} : { respondedFrom: responded }),
        });
        return;
      }

      if (envelope.type === "network_failed") {
        const payload = envelope.payload as FailedPayload & { targetId?: string };
        const id = key(payload.targetId, payload.requestId);
        const existing = byKey.get(id);
        if (existing === undefined) return;

        byKey.set(id, {
          ...existing,
          failure: classifyFailure(payload.errorText, payload.canceled === true),
        });
      }
    },
    { name: "network-collector" },
  );

  const build = (): NetworkModel => {
    const observations = order.flatMap((id) => {
      const observation = byKey.get(id);
      return observation === undefined ? [] : [observation];
    });

    const groups = new Map<string, NetworkObservation[]>();
    for (const observation of observations) {
      const list = groups.get(observation.url.origin);
      if (list === undefined) groups.set(observation.url.origin, [observation]);
      else list.push(observation);
    }

    const origins: OriginGroup[] = [...groups.entries()]
      // Sorted so a summary, a report and a golden baseline all read the same
      // way on every run.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([origin, list]) => {
        const endpoints = new Map<string, NetworkObservation[]>();
        for (const observation of list) {
          const existing = endpoints.get(observation.url.identity);
          if (existing === undefined) endpoints.set(observation.url.identity, [observation]);
          else existing.push(observation);
        }

        return {
          origin,
          endpoints,
          requests: list.length,
          // Cancellations are not failures — counting them as such buries the
          // handful that are real (see failures.ts).
          failures: list.filter((observation) => observation.failure?.isError === true).length,
          methods: [...new Set(list.map((observation) => observation.method))].sort(),
          statuses: [
            ...new Set(
              list.flatMap((observation) =>
                observation.status === undefined ? [] : [observation.status],
              ),
            ),
          ].sort((a, b) => a - b),
        };
      });

    return {
      observations,
      origins,
      inFlight: observations.filter(
        (observation) => observation.status === undefined && observation.failure === undefined,
      ).length,
    };
  };

  return {
    get model(): NetworkModel {
      return build();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}
