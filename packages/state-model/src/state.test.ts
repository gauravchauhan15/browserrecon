import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { describe, expect, it } from "vitest";
import { buildStateModel, reachableFrom, resourceOf, type ApiForState } from "./index.js";

let sequence = 0;
const reset = () => {
  sequence = 0;
};

function event<T>(type: string, payload: T): EventEnvelope {
  sequence += 1;
  return createEnvelope({
    sequence,
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    session_id: "sess_0001",
    timestamp: "2026-01-15T10:00:00.000Z",
    type: type as never,
    provenance: "observed",
    auth_context: "anonymous",
    payload,
  });
}

function api(over: Partial<ApiForState> = {}): ApiForState {
  sequence += 1;
  return {
    sequence,
    apiId: `api_${String(sequence).padStart(4, "0")}`,
    eventId: `evt_${String(sequence).padStart(6, "0")}`,
    method: "GET",
    path: "/api/thing",
    status: 200,
    authContext: "anonymous",
    ...over,
  };
}

describe("§19: the cart to order path", () => {
  it("reconstructs the transitions a checkout produces", () => {
    // The acceptance criterion: fixture cart → checkout → order
    // transitions reconstructed.
    reset();
    const events: EventEnvelope[] = [];
    const apiEvents: ApiForState[] = [
      api({ method: "POST", path: "/api/carts", status: 201, interactionId: "int_0001" }),
      api({ path: "/api/carts/{id}" }),
    ];
    events.push(event("soft_navigation", { to: "/checkout", kind: "pushState" }));
    apiEvents.push(api({ path: "/api/checkout/summary" }));
    apiEvents.push(
      api({ method: "POST", path: "/api/orders", status: 201, interactionId: "int_0002" }),
    );

    const model = buildStateModel({ apiEvents, events });
    const names = model.transitions.map((transition) => transition.to);

    expect(names).toContain("cart_created");
    expect(names).toContain("order_created");
    expect(model.initialState).toBe("anonymous");
  });

  it("names the trigger for every transition", () => {
    reset();
    const model = buildStateModel({
      apiEvents: [
        api({ method: "POST", path: "/api/orders", status: 201, interactionId: "int_0007" }),
      ],
      events: [],
    });

    const created = model.transitions.find((t) => t.to === "order_created");
    expect(created?.trigger.type).toBe("api_call");
    expect(created?.trigger.interactionId).toBe("int_0007");
    expect(created?.trigger.detail).toContain("201");
  });

  it("carries the APIs observed across each transition", () => {
    reset();
    const model = buildStateModel({
      apiEvents: [
        api({ path: "/api/catalog" }),
        api({ method: "POST", path: "/api/carts", status: 201 }),
      ],
      events: [],
    });
    expect(model.transitions[0]?.relatedApis.length).toBeGreaterThan(0);
  });
});

describe("§19: derived, and never anything else", () => {
  it("marks every transition derived", () => {
    reset();
    const model = buildStateModel({
      apiEvents: [api({ method: "POST", path: "/api/orders", status: 201 })],
      events: [event("auth_state_changed", { to: "staging-admin" })],
    });

    expect(model.transitions.length).toBeGreaterThan(0);
    for (const transition of model.transitions) {
      expect(transition.provenance).toBe("derived");
    }
  });

  it("has no code path that produces `observed`", () => {
    // §19 allows the model to be imperfect and requires it to say so. An
    // imperfect state model presented as observed fact is worse than none,
    // because the mistakes are invisible and a reader builds on them.
    //
    // The type is the enforcement — `provenance: "derived"` is a literal, so
    // an observed transition is a compile error. This asserts the literal has
    // not been widened to a string.
    reset();
    const model = buildStateModel({
      apiEvents: [api({ method: "POST", path: "/api/orders", status: 201 })],
      events: [],
    });
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain('"observed"');
  });

  it("cites the events every transition came from", () => {
    reset();
    const model = buildStateModel({
      apiEvents: [api({ method: "POST", path: "/api/orders", status: 201 })],
      events: [],
    });
    for (const transition of model.transitions) {
      expect(transition.evidence.length).toBeGreaterThan(0);
      expect(transition.evidence[0]).toMatch(/^evt_\d{6}$/);
    }
  });
});

describe("naming a state from evidence", () => {
  it("takes the resource from the path", () => {
    expect(resourceOf("/api/orders")).toBe("order");
    expect(resourceOf("/api/v2/carts")).toBe("cart");
    expect(resourceOf("/api/orders/{id}/receipt")).toBe("receipt");
  });

  it("skips route parameters and version segments", () => {
    expect(resourceOf("/api/v1/{id}")).toBeUndefined();
    expect(resourceOf("/api")).toBeUndefined();
  });

  it("does not mangle a word that merely ends in s", () => {
    // English is not worth guessing at. `status` is a word, not a plural.
    expect(resourceOf("/api/status")).toBe("status");
  });

  it("leaves a state unnamed rather than calling it {id}", () => {
    reset();
    const model = buildStateModel({
      apiEvents: [api({ method: "POST", path: "/api/{id}", status: 201 })],
      events: [],
    });
    expect(model.states).toEqual(["anonymous"]);
  });
});

describe("auth transitions", () => {
  it("records a login the log announced", () => {
    reset();
    const model = buildStateModel({
      apiEvents: [api()],
      events: [event("auth_state_changed", { to: "staging-admin" })],
    });
    expect(model.transitions.some((t) => t.to === "staging-admin")).toBe(true);
  });

  it("records a state change the log did not announce", () => {
    // §12.3's silent-logout case: the auth context on observations changes
    // without an event saying so. Left unrecorded, every later observation
    // is presented alongside authenticated coverage.
    reset();
    const model = buildStateModel({
      apiEvents: [
        api({ authContext: "anonymous" }),
        api({ authContext: "admin" }),
        api({ authContext: "anonymous" }),
      ],
      events: [event("auth_state_changed", { to: "admin" })],
    });
    expect(model.transitions.some((t) => t.to === "anonymous" && t.from === "admin")).toBe(
      true,
    );
  });
});

describe("traversal", () => {
  it("finds what a state leads to", () => {
    reset();
    const model = buildStateModel({
      apiEvents: [
        api({ method: "POST", path: "/api/carts", status: 201 }),
        api({ method: "POST", path: "/api/orders", status: 201 }),
      ],
      events: [],
    });
    expect(reachableFrom(model, "anonymous")).toContain("order_created");
  });

  it("does not hang on a cycle", () => {
    // An application that returns to a previous state is ordinary; a
    // traversal that assumes a tree runs forever on it.
    const model = {
      states: ["a", "b"],
      initialState: "a",
      transitions: [
        {
          from: "a",
          to: "b",
          trigger: { type: "api_call" as const, detail: "x" },
          relatedApis: [],
          provenance: "derived" as const,
          evidence: [],
          sequence: 1,
        },
        {
          from: "b",
          to: "a",
          trigger: { type: "api_call" as const, detail: "y" },
          relatedApis: [],
          provenance: "derived" as const,
          evidence: [],
          sequence: 2,
        },
      ],
    };
    expect(reachableFrom(model, "a")).toEqual(["b"]);
  });
});

describe("determinism", () => {
  it("produces the same graph from the same log", () => {
    const run = () => {
      reset();
      return JSON.stringify(
        buildStateModel({
          apiEvents: [
            api({ method: "POST", path: "/api/carts", status: 201 }),
            api({ path: "/api/carts/{id}" }),
            api({ method: "POST", path: "/api/orders", status: 201 }),
          ],
          events: [event("soft_navigation", { to: "/checkout", kind: "pushState" })],
        }),
      );
    };
    expect(run()).toBe(run());
  });
});
