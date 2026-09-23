import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  SIGNAL_STRENGTH,
  buildWorkflowCandidates,
  type ApiEvent,
} from "./index.js";

/**
 * §18.1's five named failure modes, each with a test.
 *
 * The plan lists them under "Required false-positive controls" and says what
 * should prevent each. A workflow detector that has not been shown failing
 * these has not been shown to work: everything downstream — the state model,
 * the workflow graph, V6's hypotheses — inherits whatever it gets wrong.
 */

let sequence = 0;
const reset = () => {
  sequence = 0;
};

function event<T>(type: string, payload: T, atMs = 0): EventEnvelope {
  sequence += 1;
  return createEnvelope({
    sequence,
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    session_id: "sess_0001",
    timestamp: new Date(atMs).toISOString(),
    type: type as never,
    provenance: "observed",
    auth_context: "anonymous",
    payload,
  });
}

function api(over: Partial<ApiEvent> = {}): ApiEvent {
  sequence += 1;
  return {
    sequence,
    apiId: `api_${String(sequence).padStart(4, "0")}`,
    routeTemplate: "/api/thing",
    timestampMs: sequence * 100,
    authContext: "anonymous",
    dependsOn: [],
    // The bundle every request comes from, as a real application has. The
    // frame is left absent by default so the strict merge rule is not
    // satisfied by accident — matching on the file alone is what merged
    // every segment into one before `shouldMerge` was narrowed.
    initiatorScript: "https://shop.example.com/app.js",
    ...over,
  };
}

const build = (apiEvents: ApiEvent[], events: EventEnvelope[] = [], over = {}) =>
  buildWorkflowCandidates({ apiEvents, events, ...over });

describe("§18.1 failure mode: polling clustered into a fake workflow", () => {
  it("does not treat repeated heartbeats as a flow", () => {
    // The control §18.1 names is §17A classification, which removes polling
    // before it reaches here. This asserts the boundary holds: given only
    // application traffic, a single endpoint hit repeatedly is not several
    // workflows — and its shape repeating must not raise confidence into
    // looking like a pattern.
    reset();
    const heartbeats = Array.from({ length: 12 }, () =>
      api({ routeTemplate: "/api/heartbeat", interactionId: undefined }),
    );
    const model = build(heartbeats);

    // One segment, not twelve, and no interaction to justify it.
    expect(model.candidates.length).toBeLessThanOrEqual(1);
    for (const candidate of model.candidates) {
      expect(candidate.interactions).toEqual([]);
      expect(candidate.lowConfidence, "a polled endpoint scored as a confident workflow").toBe(
        true,
      );
    }
  });
});

describe("§18.1 failure mode: analytics as a workflow step", () => {
  it("never sees analytics, because the input is application traffic only", () => {
    // Step 1 takes "the application_api event stream only". The filtering is
    // §17A's, and this pins the contract: nothing here re-admits it.
    reset();
    const model = build([
      api({ routeTemplate: "/api/cart", interactionId: "int_0001" }),
      api({ routeTemplate: "/api/order" }),
    ]);
    const routes = model.candidates.flatMap((candidate) => candidate.routes);
    expect(routes.every((route) => route.startsWith("/api/"))).toBe(true);
  });
});

describe("§18.1 failure mode: ID-varying instances as near-duplicate workflows", () => {
  it("treats instances of one route template as one route", () => {
    // /orders/1 and /orders/2 are one route with one handler. Emitted
    // separately they become forty near-identical workflows, and a reader
    // counting workflows learns the size of the catalogue.
    reset();
    const model = build([
      api({ routeTemplate: "/api/orders/{id}", apiId: "api_0001", interactionId: "int_0001" }),
      api({ routeTemplate: "/api/orders/{id}", apiId: "api_0001" }),
      api({ routeTemplate: "/api/orders/{id}", apiId: "api_0001" }),
    ]);

    expect(model.candidates).toHaveLength(1);
    expect(model.candidates[0]?.routes).toEqual(["/api/orders/{id}"]);
  });
});

describe("§18.1 failure mode: one giant SPA workflow", () => {
  it("splits a long session at soft navigations", () => {
    // §16's soft navigation is a strong signal precisely so an SPA session
    // with no document load does not become a single candidate.
    reset();
    const events: EventEnvelope[] = [];
    const apiEvents: ApiEvent[] = [];
    for (let screen = 0; screen < 3; screen += 1) {
      events.push(event("soft_navigation", { to: `/screen-${screen}`, kind: "pushState" }));
      apiEvents.push(
        api({ routeTemplate: `/api/screen-${screen}/a`, interactionId: `int_000${screen}` }),
      );
      apiEvents.push(api({ routeTemplate: `/api/screen-${screen}/b` }));
    }

    const model = build(apiEvents, events);
    expect(model.candidates.length).toBeGreaterThanOrEqual(3);
  });

  it("cuts one that runs away anyway, and says it did", () => {
    // The backstop when no signal ever arrives. A thousand-step candidate is
    // not a workflow anyone can read, and emitting it silently would hide
    // everything inside it.
    reset();
    const many = Array.from({ length: 150 }, (_, index) =>
      api({ routeTemplate: `/api/step-${index}` }),
    );
    const model = build(many, [], { thresholds: { maximumEvents: 20 } });

    expect(model.candidates.length).toBeGreaterThan(1);
    expect(model.candidates.some((candidate) => candidate.truncatedBy !== undefined)).toBe(
      true,
    );
    for (const candidate of model.candidates) {
      expect(candidate.events.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("§18.1 failure mode: parallel requests mistaken for a chain", () => {
  it("does not create a dependency edge the input did not carry", () => {
    // §15 forbids inferring causality from timing. This module never
    // creates edges — it reads `dependsOn` — so the assertion is that it
    // adds nothing: four concurrent requests produce a candidate whose
    // confidence gets no dependency credit.
    reset();
    const concurrent = [
      api({ routeTemplate: "/api/cart", timestampMs: 1_000, dependsOn: [] }),
      api({ routeTemplate: "/api/user", timestampMs: 1_000, dependsOn: [] }),
      api({ routeTemplate: "/api/config", timestampMs: 1_000, dependsOn: [] }),
    ];
    const model = build(concurrent);

    for (const candidate of model.candidates) {
      expect(
        candidate.evidence.map((entry) => entry.factor),
        "credited a dependency that was never observed",
      ).not.toContain("contains a depends_on edge");
    }
  });

  it("does credit one that was genuinely observed", () => {
    // The counterweight: the control must suppress invented edges, not real
    // ones.
    reset();
    const first = api({ routeTemplate: "/api/orders", apiId: "api_0001" });
    const second = api({ routeTemplate: "/api/orders/{id}", dependsOn: ["api_0001"] });
    const model = build([first, second]);

    expect(model.candidates[0]?.evidence.map((e) => e.factor)).toContain(
      "contains a depends_on edge",
    );
  });
});

describe("the six construction steps", () => {
  it("cuts at a strong signal", () => {
    reset();
    const before = api({ routeTemplate: "/api/a" });
    const beforeTwo = api({ routeTemplate: "/api/a2" });
    const nav = event("navigation_committed", { url: "https://shop.example.com/next" });
    const after = api({ routeTemplate: "/api/b" });
    const afterTwo = api({ routeTemplate: "/api/b2" });

    const model = build([before, beforeTwo, after, afterTwo], [nav]);
    expect(model.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("merges across a navigation when a dependency spans it", () => {
    // §18.1 step 3: "a single workflow often spans more than one
    // navigation". A checkout that navigates between steps is one piece of
    // work, and cutting at every navigation describes one flow as five.
    reset();
    const created = api({ routeTemplate: "/api/orders", apiId: "api_0001" });
    const nav = event("navigation_committed", { url: "https://shop.example.com/confirm" });
    const read = api({ routeTemplate: "/api/orders/{id}", dependsOn: ["api_0001"] });
    const receipt = api({ routeTemplate: "/api/orders/{id}/receipt", dependsOn: ["api_0001"] });

    const model = build([created, read, receipt], [nav]);
    expect(model.candidates).toHaveLength(1);
    expect(model.candidates[0]?.routes).toHaveLength(3);
  });

  it("discards a segment with too little traffic, and counts it", () => {
    // §18.1 step 5. Counted rather than dropped: §10C's coverage accounting
    // needs to know a visit happened even though it was not a workflow.
    reset();
    const model = build(
      [
        api({ routeTemplate: "/api/lonely" }),
        // A navigation makes the single request its own segment.
      ],
      [event("navigation_committed", { url: "https://shop.example.com/x" })],
    );

    expect(model.candidates).toHaveLength(0);
    expect(model.discarded.too_few_events).toBeGreaterThan(0);
  });
});

describe("confidence", () => {
  it("scores an interaction-driven, dependency-linked segment highly", () => {
    reset();
    const created = api({
      routeTemplate: "/api/orders",
      apiId: "api_0001",
      interactionId: "int_0001",
    });
    const read = api({ routeTemplate: "/api/orders/{id}", dependsOn: ["api_0001"] });
    const model = build([created, read]);

    expect(model.candidates[0]?.confidence).toBeGreaterThan(DEFAULT_THRESHOLDS.confidenceFloor);
    expect(model.candidates[0]?.lowConfidence).toBe(false);
  });

  it("keeps a sub-floor candidate rather than dropping it", () => {
    // §18.1: "dropped candidates cannot be reviewed, and §10C's coverage
    // accounting needs to know they existed." A tool that silently discards
    // its uncertain answers looks more confident than it is.
    //
    // Two requests from the same bundle, with no interaction and no
    // dependency: enough to survive step 4, not enough to be confident.
    reset();
    const model = build([api({ routeTemplate: "/api/x" }), api({ routeTemplate: "/api/y" })]);

    expect(model.candidates).toHaveLength(1);
    expect(model.candidates[0]?.lowConfidence).toBe(true);
  });

  it("produces nothing when every signal is weak and nothing joins", () => {
    // Worth pinning because it is surprising rather than wrong. Requests to
    // routes never seen before each raise a medium `first_seen_route`
    // signal; with no interaction, no dependency and no resolvable
    // initiator, step 4 splits at every one and step 5 discards the
    // singletons.
    //
    // The result is a scan that reports no workflows and says why in
    // `discarded` — which is the honest answer for traffic that carries no
    // evidence of being a flow. It is also the case a coverage report has to
    // explain, which is why the count is kept rather than the segments.
    reset();
    const model = build([
      api({ routeTemplate: "/api/x", initiatorScript: undefined, initiatorFrame: undefined }),
      api({ routeTemplate: "/api/y", initiatorScript: undefined, initiatorFrame: undefined }),
    ]);

    expect(model.candidates).toHaveLength(0);
    expect(model.discarded.too_few_events).toBe(2);
  });

  it("names every factor that moved the score", () => {
    // A confidence nobody can decompose is a number nobody can argue with.
    reset();
    const model = build([
      api({ routeTemplate: "/api/a", interactionId: "int_0001" }),
      api({ routeTemplate: "/api/b" }),
    ]);

    for (const entry of model.candidates[0]?.evidence ?? []) {
      expect(entry.factor.length).toBeGreaterThan(10);
      expect(Number.isFinite(entry.weight)).toBe(true);
    }
  });

  it("never scores outside 0..1", () => {
    // A reader will divide by it.
    reset();
    const model = build(
      [
        api({ routeTemplate: "/api/a", interactionId: "int_0001", dependsOn: [] }),
        api({ routeTemplate: "/api/b", initiatorScript: undefined }),
      ],
      [],
      { weights: { hasInteraction: 5, unresolvedInitiators: -5 } },
    );
    for (const candidate of model.candidates) {
      expect(candidate.confidence).toBeGreaterThanOrEqual(0);
      expect(candidate.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("signal strengths decide behaviour, not just labels", () => {
  it("grades every kind", () => {
    for (const [kind, strength] of Object.entries(SIGNAL_STRENGTH)) {
      expect(["strong", "medium", "weak"], kind).toContain(strength);
    }
  });

  it("treats a navigation as strong and idle as weak", () => {
    // The ordering is the algorithm's defence against its own failure modes:
    // a hard navigation genuinely ends a workflow, an idle gap might mean
    // the user went for coffee.
    expect(SIGNAL_STRENGTH.hard_navigation).toBe("strong");
    expect(SIGNAL_STRENGTH.soft_navigation).toBe("strong");
    expect(SIGNAL_STRENGTH.idle_period).toBe("weak");
  });
});

describe("determinism", () => {
  it("produces identical candidates from identical input", () => {
    // §18.1's own requirement, and what §36.2's golden tests rest on.
    const run = () => {
      reset();
      return JSON.stringify(
        build(
          [
            api({ routeTemplate: "/api/a", interactionId: "int_0001" }),
            api({ routeTemplate: "/api/b", dependsOn: [] }),
            api({ routeTemplate: "/api/c" }),
          ],
          [event("soft_navigation", { to: "/next", kind: "pushState" })],
        ),
      );
    };
    expect(run()).toBe(run());
  });

  it("puts every threshold in configuration", () => {
    // §18.1: thresholds are configuration "so a golden test can pin them".
    // A constant inlined at its use site changes the output of a test that
    // does not mention it.
    for (const value of Object.values(DEFAULT_THRESHOLDS)) {
      expect(typeof value).toBe("number");
    }
    expect(Object.keys(DEFAULT_THRESHOLDS).length).toBeGreaterThanOrEqual(6);
  });
});
