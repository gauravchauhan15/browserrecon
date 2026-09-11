/**
 * State shared by every CDP domain this package watches.
 *
 * The domains are wired separately — Network in one file, Page and Runtime in
 * another — but they must share one attachment, one emission queue and one set
 * of counters. Two independent `Target.setAutoAttach` calls on the same
 * browser would fight: the second replaces the first's settings, and only one
 * of them would ever hear about a new target. So the attach shell
 * (telemetry.ts) owns all of it and hands each domain this.
 */
import type { Logger } from "@browserrecon/core";
import type { EventBus, EventType } from "@browserrecon/events";
import type { BodyCaptureLimits } from "./body-policy.js";

/** Mutable tallies, read through `TelemetryStats`. */
export interface Counters {
  requests: number;
  responses: number;
  failures: number;
  bodiesCaptured: number;
  bodyBytes: number;
  orphanEvents: number;
  navigations: number;
  frames: number;
  executionContexts: number;
  scripts: number;
}

export function newCounters(): Counters {
  return {
    requests: 0,
    responses: 0,
    failures: 0,
    bodiesCaptured: 0,
    bodyBytes: 0,
    orphanEvents: 0,
    navigations: 0,
    frames: 0,
    executionContexts: 0,
    scripts: 0,
  };
}

export interface TelemetryContext {
  readonly bus: EventBus;
  /** §12.3 makes this mandatory on every event, and it is never inferred. */
  readonly authContext: string;
  readonly log: Logger;
  readonly limits: BodyCaptureLimits;
  readonly counters: Counters;
  /**
   * Queue an emission.
   *
   * Every domain publishes through this rather than calling the bus directly,
   * so one chain orders all of them against each other. A navigation and the
   * requests it caused have to appear in the log in the order Chrome reported
   * them, and they arrive on different domains.
   */
  readonly enqueue: (work: () => Promise<void>) => void;
  /** Record that a CDP event arrived, for `drain`'s quiet-period check. */
  readonly touch: () => void;
  /** Publish one event. Thin, but it keeps `provenance` honest in one place. */
  readonly emit: (type: EventType, payload: unknown, ids?: EventIds) => void;
}

/** Envelope fields a domain can attribute an event to. */
export interface EventIds {
  readonly page_id?: string | undefined;
  readonly navigation_id?: string | undefined;
}
