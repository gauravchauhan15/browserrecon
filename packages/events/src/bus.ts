/**
 * Event Bus — build plan §5, §22.1.
 *
 * Sits between the collectors that observe and the consumers that persist. Its
 * whole reason for existing is §32.9: an event must be durable before it is
 * considered processed. Everything here serves that.
 *
 * The bus is the **ordering authority**. It assigns `sequence` and `event_id`
 * synchronously at publish time, so numbering follows call order exactly and
 * has no gaps — which is what makes replay and golden-output comparison
 * possible (§36.2).
 *
 * Scope is deliberately narrow. Correlation is *not* a subscriber: dev plan
 * §1.2 requires everything from correlation rightward to run against a
 * recorded `events.jsonl` with no browser present, so it reads the log
 * afterwards rather than listening live. The bus therefore serves durability
 * and live counters, not the derived model.
 */
import { IdFactory } from "@browserrecon/core";
import { createEnvelope, type EventEnvelope } from "./envelope.js";
import type { EventType } from "./event-types.js";
import type { Provenance } from "./provenance.js";

/** What a subscriber receives. */
export type EventHandler = (envelope: EventEnvelope) => void | Promise<void>;

export interface SubscribeOptions {
  /** Named so a failure can say *which* subscriber broke. */
  readonly name: string;
  /**
   * A subscriber whose failure must stop the scan.
   *
   * The event store is critical: if an event cannot be persisted, continuing
   * would mean collecting observations that are already lost, and reporting
   * coverage over data that does not exist. Everything else — counters,
   * progress display — is not, and its failure must not take a scan down.
   */
  readonly critical?: boolean;
}

/** Remove a subscriber. Safe to call twice. */
export type Unsubscribe = () => void;

/** A subscriber that threw. */
export interface SubscriberFailure {
  readonly subscriber: string;
  readonly eventId: string;
  readonly error: Error;
}

export interface EventBusOptions {
  readonly sessionOrdinal?: number | undefined;
  /**
   * How many published-but-undelivered events to tolerate.
   *
   * Exceeding this rejects the publish rather than queueing without bound.
   * See the backpressure note on `publish`.
   */
  readonly maxQueueDepth?: number | undefined;
  /** Called for each non-critical subscriber failure. */
  readonly onSubscriberFailure?: ((failure: SubscriberFailure) => void) | undefined;
  /** Injected for deterministic timestamps in tests. */
  readonly now?: (() => Date) | undefined;
}

/** What to publish. The bus supplies identity, ordering and timestamp. */
export interface PublishInput<TPayload = unknown> {
  readonly type: EventType;
  readonly provenance: Provenance;
  readonly auth_context: string;
  readonly payload: TPayload;
  readonly page_id?: string | undefined;
  readonly navigation_id?: string | undefined;
  readonly workflow_id?: string | undefined;
}

export interface EventBusStats {
  readonly published: number;
  readonly delivered: number;
  readonly subscriberFailures: number;
  readonly queueDepth: number;
}

/** Raised when the queue cap is exceeded. */
export class EventBusOverflowError extends Error {
  constructor(depth: number, cap: number) {
    super(
      `Event bus queue depth ${depth} exceeded its cap of ${cap}. ` +
        "A producer is publishing faster than subscribers can persist. Await the " +
        "promise returned by publish() to apply backpressure.",
    );
    this.name = "EventBusOverflowError";
  }
}

/** Raised when a critical subscriber fails. */
export class CriticalSubscriberError extends Error {
  constructor(
    readonly subscriber: string,
    readonly eventId: string,
    override readonly cause: Error,
  ) {
    super(`Critical subscriber "${subscriber}" failed handling ${eventId}: ${cause.message}`);
    this.name = "CriticalSubscriberError";
  }
}

interface Registration {
  readonly id: number;
  readonly name: string;
  readonly critical: boolean;
  readonly handler: EventHandler;
}

const DEFAULT_MAX_QUEUE_DEPTH = 1024;

export class EventBus {
  readonly #ids: IdFactory;
  readonly #subscribers = new Map<number, Registration>();
  readonly #maxQueueDepth: number;
  readonly #onSubscriberFailure: ((failure: SubscriberFailure) => void) | undefined;
  readonly #now: () => Date;

  #nextSubscriberId = 1;
  #sequence = 0;
  #queueDepth = 0;
  #published = 0;
  #delivered = 0;
  #subscriberFailures = 0;

  /** Serializes delivery so subscribers see events in published order. */
  #tail: Promise<void> = Promise.resolve();

  constructor(options: EventBusOptions = {}) {
    this.#ids = new IdFactory(options.sessionOrdinal ?? 1);
    this.#maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.#onSubscriberFailure = options.onSubscriberFailure;
    this.#now = options.now ?? ((): Date => new Date());
  }

  get sessionId(): string {
    return this.#ids.sessionId;
  }

  get stats(): EventBusStats {
    return {
      published: this.#published,
      delivered: this.#delivered,
      subscriberFailures: this.#subscriberFailures,
      queueDepth: this.#queueDepth,
    };
  }

  subscribe(handler: EventHandler, options: SubscribeOptions): Unsubscribe {
    const id = this.#nextSubscriberId++;
    this.#subscribers.set(id, {
      id,
      name: options.name,
      critical: options.critical ?? false,
      handler,
    });
    return () => {
      this.#subscribers.delete(id);
    };
  }

  /**
   * Publish an event.
   *
   * Identity and ordering are assigned **synchronously**, before any await, so
   * `sequence` follows call order and cannot gap or interleave. Delivery is
   * then queued behind any earlier event.
   *
   * **On backpressure, honestly.** JavaScript cannot force a caller who
   * ignores this promise to slow down; there is no blocking send. What this
   * gives you is: a producer that awaits is naturally throttled to the speed
   * of its subscribers, and a producer that does not is *detected* — the queue
   * cap turns unbounded growth into a loud `EventBusOverflowError` instead of
   * silent memory exhaustion or dropped events. Claiming more than that would
   * be a guarantee the runtime cannot keep.
   */
  publish<TPayload>(input: PublishInput<TPayload>): Promise<EventEnvelope<TPayload>> {
    if (this.#queueDepth >= this.#maxQueueDepth) {
      return Promise.reject(new EventBusOverflowError(this.#queueDepth, this.#maxQueueDepth));
    }

    const envelope = createEnvelope<TPayload>({
      event_id: this.#ids.next("event"),
      session_id: this.#ids.sessionId,
      sequence: ++this.#sequence,
      timestamp: this.#now().toISOString(),
      type: input.type,
      provenance: input.provenance,
      auth_context: input.auth_context,
      payload: input.payload,
      page_id: input.page_id,
      navigation_id: input.navigation_id,
      workflow_id: input.workflow_id,
    });

    this.#published++;
    this.#queueDepth++;

    const work = this.#tail.then(() => this.#deliver(envelope));

    // The chain must survive a rejection, or one critical failure would
    // permanently wedge every later event behind a settled-rejected promise.
    this.#tail = work.then(
      () => undefined,
      () => undefined,
    );

    return work.then(
      () => {
        this.#queueDepth--;
        this.#delivered++;
        return envelope;
      },
      (error: unknown) => {
        this.#queueDepth--;
        throw error;
      },
    );
  }

  /**
   * Deliver to every subscriber, in registration order.
   *
   * Sequential rather than parallel: a subscriber that persists must finish
   * before one that counts, and interleaving would make failure attribution
   * ambiguous.
   */
  async #deliver(envelope: EventEnvelope): Promise<void> {
    for (const registration of [...this.#subscribers.values()]) {
      try {
        await registration.handler(envelope);
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));

        if (registration.critical) {
          throw new CriticalSubscriberError(registration.name, envelope.event_id, error);
        }

        // Isolated: one broken consumer must not stop dispatch to the others,
        // and must not stop the scan. It is counted and reported so the
        // failure is visible rather than absorbed.
        this.#subscriberFailures++;
        this.#onSubscriberFailure?.({
          subscriber: registration.name,
          eventId: envelope.event_id,
          error,
        });
      }
    }
  }

  /**
   * Wait for every published event to finish delivery.
   *
   * Called at scan end before the process exits, so nothing in flight is lost
   * on shutdown.
   */
  async drain(): Promise<void> {
    await this.#tail;
  }
}
