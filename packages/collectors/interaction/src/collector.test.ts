import { describe, expect, it } from "vitest";
import { EventBus, type EventEnvelope } from "@browserrecon/events";
import type {
  ActionOptions,
  ActionResult,
  BrowserAdapter,
  ElementFacts,
} from "@browserrecon/browser-adapter";
import { recordInteractions } from "./collector.js";

/** An adapter that answers however a test needs, and records what it was asked. */
function stubAdapter(overrides: Partial<BrowserAdapter> = {}): BrowserAdapter & {
  calls: string[];
} {
  const calls: string[] = [];
  const facts: ElementFacts = {
    tagName: "button",
    accessibleName: "place order",
    inForm: true,
    nonGetMethod: false,
    id: "place-order",
  };

  return {
    calls,
    currentUrl: "https://app.test/",
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`);
      return { status: "ok", value: { url, redirected: false } } as ActionResult<never>;
    },
    click: async (selector: string) => {
      calls.push(`click:${selector}`);
      return { status: "ok", value: facts } as ActionResult<never>;
    },
    type: async (selector: string, text: string) => {
      calls.push(`type:${selector}:${text}`);
      return { status: "ok", value: undefined } as ActionResult<never>;
    },
    scroll: async (direction: string) => {
      calls.push(`scroll:${direction}`);
      return { status: "ok", value: undefined } as ActionResult<never>;
    },
    back: async () => {
      calls.push("back");
      return {
        status: "ok",
        value: { url: "https://app.test/", redirected: false },
      } as ActionResult<never>;
    },
    waitForSettled: async (_options?: ActionOptions) => {
      calls.push("wait");
      return { status: "ok", value: { waitedMs: 0, settled: true } } as ActionResult<never>;
    },
    close: async () => {
      calls.push("close");
    },
    ...overrides,
  } as BrowserAdapter & { calls: string[] };
}

const collect = (bus: EventBus): EventEnvelope[] => {
  const seen: EventEnvelope[] = [];
  bus.subscribe((envelope) => void seen.push(envelope), { name: "collector" });
  return seen;
};

describe("every action becomes exactly one interaction", () => {
  it("records navigate, click, type, scroll and back", async () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    await adapter.navigate("https://app.test/orders");
    await adapter.click("#place-order");
    await adapter.type("#email", "someone@example.com");
    await adapter.scroll("bottom");
    await adapter.back();
    await bus.drain();

    expect(seen.map((envelope) => (envelope.payload as { kind: string }).kind)).toEqual([
      "navigate",
      "click",
      "type",
      "scroll",
      "back",
    ]);
  });

  it("does not record waiting, which changes nothing", async () => {
    // An event between a click and the requests it caused is precisely the
    // sequence §15 reads, so a no-op must not appear in it.
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    await adapter.click("#go");
    await adapter.waitForSettled();
    await bus.drain();

    expect(seen).toHaveLength(1);
  });

  it("emits one event per action, not one per attempt", async () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    for (let index = 0; index < 5; index += 1) await adapter.click("#go");
    await bus.drain();

    expect(seen).toHaveLength(5);
    expect(
      new Set(seen.map((e) => (e.payload as { interactionId: string }).interactionId)).size,
    ).toBe(5);
  });

  it("still performs the action it is wrapping", async () => {
    // A recording wrapper that swallowed the call would be a very quiet bug.
    const inner = stubAdapter();
    const adapter = recordInteractions({ adapter: inner, bus: new EventBus() });

    await adapter.navigate("https://app.test/a");
    await adapter.click("#go");
    await adapter.close();

    expect(inner.calls).toEqual(["navigate:https://app.test/a", "click:#go", "close"]);
  });

  it("passes the adapter's own result straight back", async () => {
    const adapter = recordInteractions({ adapter: stubAdapter(), bus: new EventBus() });
    const result = await adapter.navigate("https://app.test/a");
    expect(result.status).toBe("ok");
  });
});

describe("ids", () => {
  it("allocates deterministic ids", async () => {
    // Golden output compares these across runs (§1, §36.2).
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    await adapter.click("#a");
    await adapter.click("#b");
    await bus.drain();

    expect(seen.map((e) => (e.payload as { interactionId: string }).interactionId)).toEqual([
      "int_0001",
      "int_0002",
    ]);
  });

  it("exposes the current id, so a caller can correlate without guessing", async () => {
    const adapter = recordInteractions({ adapter: stubAdapter(), bus: new EventBus() });
    expect(adapter.currentInteractionId).toBeUndefined();

    await adapter.click("#a");
    expect(adapter.currentInteractionId).toBe("int_0001");
  });
});

describe("what the event carries", () => {
  it("carries a stable reference to the element that was clicked", async () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    await adapter.click("#place-order");
    await bus.drain();

    const payload = seen[0]?.payload as {
      element?: { selector: string; strategy: string };
      requestedSelector?: string;
    };
    expect(payload.element?.selector).toBe("#place-order");
    expect(payload.element?.strategy).toBe("id");
    expect(payload.requestedSelector).toBe("#place-order");
  });

  it("records the outcome, because a refused action is a different event", async () => {
    // §8.6 wants a policy refusal recorded as a barrier, not lost.
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({
      adapter: stubAdapter({
        click: async () =>
          ({
            status: "denied",
            action: "click",
            reason: "action_state_changing_denied",
            detail: "no",
            barrier: "scope_excluded",
          }) as ActionResult<never>,
      }),
      bus,
    });

    await adapter.click("#delete");
    await bus.drain();

    const payload = seen[0]?.payload as { outcome: string; denialReason?: string };
    expect(payload.outcome).toBe("denied");
    expect(payload.denialReason).toBe("action_state_changing_denied");
  });

  it("records a failure distinctly from a denial", async () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({
      adapter: stubAdapter({
        click: async () =>
          ({
            status: "failed",
            action: "click",
            kind: "element_not_found",
            detail: "gone",
          }) as ActionResult<never>,
      }),
      bus,
    });

    await adapter.click("#missing");
    await bus.drain();

    const payload = seen[0]?.payload as { outcome: string; failureKind?: string };
    expect(payload.outcome).toBe("failed");
    expect(payload.failureKind).toBe("element_not_found");
  });

  it("never records what was typed", async () => {
    // A scan types credentials into login forms. The event store is raw and
    // local, but exports are not (§37.2) — and the selector is enough to
    // reproduce the step without carrying the secret through every stage.
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    await adapter.type("#password", "hunter2-correct-horse");
    await bus.drain();

    expect(JSON.stringify(seen[0]?.payload)).not.toContain("hunter2");
    expect((seen[0]?.payload as { requestedSelector?: string }).requestedSelector).toBe(
      "#password",
    );
  });

  it("scopes an interaction to its frame, so attribution cannot cross one", async () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const adapter = recordInteractions({
      adapter: stubAdapter(),
      bus,
      frameId: "F1",
      targetId: "page:1",
    });

    await adapter.click("#go");
    await bus.drain();

    expect(seen[0]?.payload).toMatchObject({ frameId: "F1", targetId: "page:1" });
  });
});

describe("the model", () => {
  it("counts interactions by kind and remembers the latest", async () => {
    const bus = new EventBus();
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    await adapter.click("#a");
    await adapter.click("#b");
    await adapter.navigate("https://app.test/x");
    await bus.drain();

    expect(adapter.model.byKind.get("click")).toBe(2);
    expect(adapter.model.byKind.get("navigate")).toBe(1);
    expect(adapter.model.latest?.kind).toBe("navigate");
  });

  it("carries the envelope sequence, which is the ordering authority", async () => {
    const bus = new EventBus();
    const adapter = recordInteractions({ adapter: stubAdapter(), bus });

    await adapter.click("#a");
    await adapter.click("#b");
    await bus.drain();

    const sequences = adapter.model.interactions.map((interaction) => interaction.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });
});
