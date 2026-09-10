import { describe, expect, it, vi } from "vitest";
import {
  CriticalSubscriberError,
  EventBus,
  EventBusOverflowError,
  type PublishInput,
  type SubscriberFailure,
} from "./bus.js";
import { validateEnvelope, type EventEnvelope } from "./envelope.js";

const event = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  type: "network_request",
  provenance: "observed",
  auth_context: "anonymous",
  payload: {},
  ...overrides,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("identity and ordering", () => {
  it("assigns gapless, strictly increasing sequence numbers", () => {
    // The bus is the ordering authority. A gap or a repeat would break replay
    // and every golden-output comparison (§36.2).
    const bus = new EventBus();
    const published = [bus.publish(event()), bus.publish(event()), bus.publish(event())];

    return Promise.all(published).then((envelopes) => {
      expect(envelopes.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(envelopes.map((e) => e.event_id)).toEqual([
        "evt_000001",
        "evt_000002",
        "evt_000003",
      ]);
    });
  });

  it("numbers in call order even when publishes are not awaited individually", () => {
    // Identity is assigned synchronously before any await, so concurrent
    // callers cannot interleave their numbering.
    const bus = new EventBus();
    const first = bus.publish(event({ type: "page_loaded" }));
    const second = bus.publish(event({ type: "interaction" }));

    return Promise.all([first, second]).then(([a, b]) => {
      expect(a.sequence).toBe(1);
      expect(b.sequence).toBe(2);
    });
  });

  it("delivers to subscribers in published order", async () => {
    const bus = new EventBus();
    const seen: number[] = [];

    bus.subscribe(
      async (envelope) => {
        // Deliberately slower for earlier events: if delivery were parallel,
        // this would reorder them.
        await sleep(envelope.sequence === 1 ? 20 : 1);
        seen.push(envelope.sequence);
      },
      { name: "recorder" },
    );

    await Promise.all([bus.publish(event()), bus.publish(event()), bus.publish(event())]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stamps a session id shared by every event", async () => {
    const bus = new EventBus({ sessionOrdinal: 7 });
    const envelope = await bus.publish(event());
    expect(envelope.session_id).toBe("sess_0007");
    expect(bus.sessionId).toBe("sess_0007");
  });

  it("produces envelopes that pass validation", async () => {
    const bus = new EventBus();
    const envelope = await bus.publish(
      event({ page_id: undefined, payload: { method: "GET" } }),
    );
    expect(validateEnvelope(envelope).ok).toBe(true);
  });

  it("keeps optional context off the envelope when not supplied", async () => {
    const bus = new EventBus();
    const envelope = await bus.publish(event());
    expect("page_id" in envelope).toBe(false);
    expect("workflow_id" in envelope).toBe(false);
  });
});

describe("backpressure", () => {
  it("resolves only after subscribers have handled the event", async () => {
    // This is what makes an awaiting producer self-throttling: publish() does
    // not resolve until the event has actually been consumed.
    const bus = new EventBus();
    let handled = false;

    bus.subscribe(
      async () => {
        await sleep(20);
        handled = true;
      },
      { name: "slow-store" },
    );

    await bus.publish(event());
    expect(handled).toBe(true);
  });

  it("loses nothing when a subscriber is much slower than the producer", async () => {
    // BR-M0-08 acceptance criterion. 50 events, a deliberately slow consumer,
    // and every single one must arrive in order.
    const bus = new EventBus();
    const seen: number[] = [];

    bus.subscribe(
      async (envelope) => {
        await sleep(1);
        seen.push(envelope.sequence);
      },
      { name: "slow-store" },
    );

    const count = 50;
    await Promise.all(Array.from({ length: count }, () => bus.publish(event())));

    expect(seen).toHaveLength(count);
    expect(seen).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(bus.stats.delivered).toBe(count);
  });

  it("rejects rather than queueing without bound when the cap is exceeded", async () => {
    // JavaScript cannot force a non-awaiting producer to slow down, so the
    // cap turns runaway growth into a loud failure instead of silent memory
    // exhaustion or dropped events.
    const bus = new EventBus({ maxQueueDepth: 3 });
    bus.subscribe(() => sleep(50), { name: "slow" });

    const inFlight = [bus.publish(event()), bus.publish(event()), bus.publish(event())];

    await expect(bus.publish(event())).rejects.toThrow(EventBusOverflowError);
    await expect(bus.publish(event())).rejects.toThrow(/Await the promise returned by publish/);

    await Promise.all(inFlight);
  });

  it("accepts again once the queue drains", async () => {
    const bus = new EventBus({ maxQueueDepth: 2 });
    bus.subscribe(() => sleep(10), { name: "slow" });

    const inFlight = [bus.publish(event()), bus.publish(event())];
    await expect(bus.publish(event())).rejects.toThrow(EventBusOverflowError);

    await Promise.all(inFlight);
    await expect(bus.publish(event())).resolves.toBeDefined();
  });

  it("reports queue depth so a producer can check before pushing", async () => {
    const bus = new EventBus();
    bus.subscribe(() => sleep(20), { name: "slow" });

    const pending = bus.publish(event());
    expect(bus.stats.queueDepth).toBe(1);

    await pending;
    expect(bus.stats.queueDepth).toBe(0);
  });
});

describe("subscriber failure isolation", () => {
  it("keeps delivering to other subscribers when one throws", async () => {
    // A broken counter must not cost us the event store.
    const bus = new EventBus();
    const seen: string[] = [];

    bus.subscribe(
      () => {
        throw new Error("boom");
      },
      { name: "broken" },
    );
    bus.subscribe((envelope) => void seen.push(envelope.event_id), { name: "healthy" });

    await bus.publish(event());
    expect(seen).toEqual(["evt_000001"]);
  });

  it("keeps delivering later events after a failure", async () => {
    const bus = new EventBus();
    const seen: number[] = [];
    let calls = 0;

    bus.subscribe(
      () => {
        calls++;
        if (calls === 1) throw new Error("transient");
      },
      { name: "flaky" },
    );
    bus.subscribe((envelope) => void seen.push(envelope.sequence), { name: "healthy" });

    await Promise.all([bus.publish(event()), bus.publish(event())]);
    expect(seen).toEqual([1, 2]);
  });

  it("reports the failure with the subscriber name and event id", async () => {
    // Absorbed failures are how a scan quietly stops recording something.
    const failures: SubscriberFailure[] = [];
    const bus = new EventBus({ onSubscriberFailure: (f) => void failures.push(f) });

    bus.subscribe(
      () => {
        throw new Error("counter overflowed");
      },
      { name: "statistics" },
    );

    await bus.publish(event());

    expect(failures).toHaveLength(1);
    expect(failures[0]?.subscriber).toBe("statistics");
    expect(failures[0]?.eventId).toBe("evt_000001");
    expect(failures[0]?.error.message).toBe("counter overflowed");
    expect(bus.stats.subscriberFailures).toBe(1);
  });

  it("normalizes a non-Error throw", async () => {
    const failures: SubscriberFailure[] = [];
    const bus = new EventBus({ onSubscriberFailure: (f) => void failures.push(f) });
    bus.subscribe(
      () => {
        throw "just a string";
      },
      { name: "rude" },
    );

    await bus.publish(event());
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect(failures[0]?.error.message).toBe("just a string");
  });

  it("handles a rejected promise the same as a synchronous throw", async () => {
    const failures: SubscriberFailure[] = [];
    const bus = new EventBus({ onSubscriberFailure: (f) => void failures.push(f) });
    bus.subscribe(() => Promise.reject(new Error("async boom")), { name: "async-broken" });

    await bus.publish(event());
    expect(failures).toHaveLength(1);
  });
});

describe("critical subscribers", () => {
  it("propagates a failure to the publisher", async () => {
    // If an event cannot be persisted, continuing would mean collecting
    // observations that are already lost and reporting coverage over data
    // that does not exist (§32.9).
    const bus = new EventBus();
    bus.subscribe(
      () => {
        throw new Error("disk full");
      },
      { name: "event-store", critical: true },
    );

    await expect(bus.publish(event())).rejects.toThrow(CriticalSubscriberError);
    await expect(bus.publish(event())).rejects.toThrow(/event-store/);
  });

  it("does not wedge the queue after a critical failure", async () => {
    // The delivery chain has to survive a rejection, or every later event
    // would sit behind a settled-rejected promise forever.
    const bus = new EventBus();
    let failNext = true;

    bus.subscribe(
      () => {
        if (failNext) {
          failNext = false;
          throw new Error("transient disk error");
        }
      },
      { name: "event-store", critical: true },
    );

    await expect(bus.publish(event())).rejects.toThrow(CriticalSubscriberError);
    await expect(bus.publish(event())).resolves.toBeDefined();
  });

  it("names the event that could not be persisted", async () => {
    const bus = new EventBus();
    bus.subscribe(
      () => {
        throw new Error("nope");
      },
      { name: "event-store", critical: true },
    );

    await bus.publish(event()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CriticalSubscriberError);
      if (error instanceof CriticalSubscriberError) {
        expect(error.eventId).toBe("evt_000001");
        expect(error.subscriber).toBe("event-store");
        expect(error.cause.message).toBe("nope");
      }
    });
  });
});

describe("subscription lifecycle", () => {
  it("stops delivering after unsubscribe", async () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.subscribe((e) => void seen.push(e.sequence), { name: "temp" });

    await bus.publish(event());
    off();
    await bus.publish(event());

    expect(seen).toEqual([1]);
  });

  it("tolerates unsubscribing twice", () => {
    const bus = new EventBus();
    const off = bus.subscribe(() => {}, { name: "temp" });
    off();
    expect(() => off()).not.toThrow();
  });

  it("delivers in registration order", async () => {
    const order: string[] = [];
    const bus = new EventBus();
    bus.subscribe(() => void order.push("first"), { name: "first" });
    bus.subscribe(() => void order.push("second"), { name: "second" });

    await bus.publish(event());
    expect(order).toEqual(["first", "second"]);
  });

  it("is not disturbed by a subscriber that unsubscribes mid-dispatch", async () => {
    // Iterating a snapshot rather than the live map, so mutation during
    // delivery cannot skip a subscriber or throw.
    const bus = new EventBus();
    const seen: string[] = [];

    const off = bus.subscribe(
      () => {
        off();
        seen.push("self-removing");
      },
      { name: "self-removing" },
    );
    bus.subscribe(() => void seen.push("other"), { name: "other" });

    await bus.publish(event());
    expect(seen).toEqual(["self-removing", "other"]);
  });

  it("publishes fine with no subscribers at all", async () => {
    const bus = new EventBus();
    const envelope = await bus.publish(event());
    expect(envelope.sequence).toBe(1);
    expect(bus.stats.delivered).toBe(1);
  });
});

describe("drain", () => {
  it("waits for in-flight delivery, so shutdown loses nothing", async () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe(
      async (e) => {
        await sleep(10);
        seen.push(e.sequence);
      },
      { name: "slow" },
    );

    void bus.publish(event());
    void bus.publish(event());
    await bus.drain();

    expect(seen).toEqual([1, 2]);
  });

  it("resolves immediately when idle", async () => {
    await expect(new EventBus().drain()).resolves.toBeUndefined();
  });
});

describe("timestamps", () => {
  it("uses the injected clock, so golden tests stay stable", async () => {
    const bus = new EventBus({ now: () => new Date("2026-09-10T09:15:23.182Z") });
    const envelope = await bus.publish(event());
    expect(envelope.timestamp).toBe("2026-09-10T09:15:23.182Z");
  });

  it("orders by sequence, not by clock", async () => {
    // Two events can share a millisecond, and §15 forbids inferring causality
    // from timing — so sequence is the ordering authority, not the timestamp.
    const frozen = () => new Date("2026-09-10T09:15:23.182Z");
    const bus = new EventBus({ now: frozen });
    const envelopes: EventEnvelope[] = await Promise.all([
      bus.publish(event()),
      bus.publish(event()),
    ]);

    expect(envelopes[0]?.timestamp).toBe(envelopes[1]?.timestamp);
    expect(envelopes[0]?.sequence).toBeLessThan(envelopes[1]?.sequence ?? 0);
  });
});

describe("stats", () => {
  it("counts published, delivered and failures separately", async () => {
    const bus = new EventBus({ onSubscriberFailure: () => {} });
    bus.subscribe(
      () => {
        throw new Error("x");
      },
      { name: "broken" },
    );

    await bus.publish(event());
    await bus.publish(event());

    expect(bus.stats).toEqual({
      published: 2,
      delivered: 2,
      subscriberFailures: 2,
      queueDepth: 0,
    });
  });

  it("does not count a rejected publish as delivered", async () => {
    const bus = new EventBus();
    bus.subscribe(
      () => {
        throw new Error("disk full");
      },
      { name: "event-store", critical: true },
    );

    await bus.publish(event()).catch(() => undefined);

    expect(bus.stats.published).toBe(1);
    expect(bus.stats.delivered).toBe(0);
    expect(bus.stats.queueDepth).toBe(0);
  });
});

describe("handler invocation", () => {
  it("passes the same envelope object to every subscriber", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const bus = new EventBus();
    bus.subscribe(first, { name: "a" });
    bus.subscribe(second, { name: "b" });

    const envelope = await bus.publish(event());
    expect(first).toHaveBeenCalledWith(envelope);
    expect(second).toHaveBeenCalledWith(envelope);
  });
});
