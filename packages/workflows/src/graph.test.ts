import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RELATIONSHIPS,
  buildWorkflowGraph,
  structuralEdges,
  type WorkflowCandidate,
} from "./index.js";

let counter = 0;

function candidate(over: Partial<WorkflowCandidate> = {}): WorkflowCandidate {
  counter += 1;
  const base = counter * 100;
  return {
    workflow_id: `wf_${String(counter).padStart(4, "0")}`,
    events: [
      {
        sequence: base,
        apiId: `api_${base}`,
        routeTemplate: "/api/thing",
        timestampMs: base,
        authContext: "anonymous",
        dependsOn: [],
      },
    ],
    confidence: 0.8,
    evidence: [],
    lowConfidence: false,
    authContext: "anonymous",
    routes: ["/api/thing"],
    interactions: [],
    ...over,
  };
}

const reset = () => {
  counter = 0;
};

describe("§20.1: relationships come from shared state, not co-occurrence", () => {
  it("draws no edge between workflows that merely happened in order", () => {
    // BR-M3-06's acceptance criterion. Two workflows that ran one after
    // another are two workflows that ran one after another — on a site where
    // the explorer walks checkout before login, the naive version says
    // checkout enables login.
    reset();
    const graph = buildWorkflowGraph({
      candidates: [candidate({ routes: ["/api/alpha"] }), candidate({ routes: ["/api/beta"] })],
    });
    expect(graph.edges).toEqual([]);
  });

  it("draws depends_on when an API genuinely needed another's output", () => {
    reset();
    const first = candidate({
      routes: ["/api/orders"],
      events: [
        {
          sequence: 1,
          apiId: "api_create",
          routeTemplate: "/api/orders",
          timestampMs: 1,
          authContext: "anonymous",
          dependsOn: [],
        },
      ],
    });
    const second = candidate({
      routes: ["/api/orders/{id}"],
      events: [
        {
          sequence: 2,
          apiId: "api_read",
          routeTemplate: "/api/orders/{id}",
          timestampMs: 2,
          authContext: "anonymous",
          dependsOn: ["api_create"],
        },
      ],
    });

    const graph = buildWorkflowGraph({ candidates: [first, second] });
    const dependency = graph.edges.find((edge) => edge.relationship === "depends_on");

    expect(dependency?.from).toBe(second.workflow_id);
    expect(dependency?.to).toBe(first.workflow_id);
    // And the mirror, which is what a reader traversing forwards wants.
    expect(
      graph.edges.some((e) => e.relationship === "enables" && e.from === first.workflow_id),
    ).toBe(true);
  });

  it("draws shares_state_with when both touch the same route", () => {
    reset();
    const graph = buildWorkflowGraph({
      candidates: [
        candidate({ routes: ["/api/cart/{id}", "/api/catalog"] }),
        candidate({ routes: ["/api/cart/{id}", "/api/checkout"] }),
      ],
    });
    const shared = graph.edges.find((edge) => edge.relationship === "shares_state_with");
    expect(shared?.basis).toContain("/api/cart/{id}");
  });

  it("draws requires when the later one ran authenticated", () => {
    reset();
    const graph = buildWorkflowGraph({
      candidates: [
        candidate({ authContext: "anonymous", routes: ["/api/login-page"] }),
        candidate({ authContext: "staging-admin", routes: ["/api/admin"] }),
      ],
    });
    const requires = graph.edges.find((edge) => edge.relationship === "requires");
    expect(requires?.basis).toContain("staging-admin");
  });

  it("draws enables when a state transition crossed between them", () => {
    reset();
    const first = candidate({
      routes: ["/api/a"],
      events: [
        {
          sequence: 10,
          apiId: "a",
          routeTemplate: "/api/a",
          timestampMs: 10,
          authContext: "anonymous",
          dependsOn: [],
        },
      ],
    });
    const second = candidate({
      routes: ["/api/b"],
      events: [
        {
          sequence: 30,
          apiId: "b",
          routeTemplate: "/api/b",
          timestampMs: 30,
          authContext: "anonymous",
          dependsOn: [],
        },
      ],
    });

    const graph = buildWorkflowGraph({
      candidates: [first, second],
      transitions: [{ from: "cart_empty", to: "cart_has_item", sequence: 20 }],
    });
    const enables = graph.edges.find((edge) => edge.relationship === "enables");
    expect(enables?.basis).toContain("cart_has_item");
  });

  it("names the shared thing in every basis", () => {
    // A relationship nobody can check is co-occurrence wearing a label.
    reset();
    const graph = buildWorkflowGraph({
      candidates: [
        candidate({ routes: ["/api/shared"] }),
        candidate({ routes: ["/api/shared"] }),
      ],
    });
    for (const edge of graph.edges) {
      expect(edge.basis.length, edge.relationship).toBeGreaterThan(10);
    }
  });
});

describe("adjacency is offered separately, and weakly", () => {
  it("is off by default", () => {
    reset();
    const graph = buildWorkflowGraph({
      candidates: [candidate({ routes: ["/api/a"] }), candidate({ routes: ["/api/b"] })],
    });
    expect(graph.edges.some((edge) => edge.relationship === "follows")).toBe(false);
  });

  it("says what it is when asked for", () => {
    reset();
    const graph = buildWorkflowGraph({
      candidates: [candidate({ routes: ["/api/a"] }), candidate({ routes: ["/api/b"] })],
      includeAdjacency: true,
    });
    const follows = graph.edges.find((edge) => edge.relationship === "follows");

    expect(follows?.basis).toContain("adjacency only");
    // Weakest by construction, so a consumer can filter on the number as
    // well as on the type.
    expect(follows?.confidence).toBeLessThan(0.5);
  });

  it("is excluded from the structural view", () => {
    reset();
    const graph = buildWorkflowGraph({
      candidates: [
        candidate({ routes: ["/api/shared"] }),
        candidate({ routes: ["/api/shared"] }),
      ],
      includeAdjacency: true,
    });
    expect(graph.edges.length).toBeGreaterThan(structuralEdges(graph).length);
    expect(structuralEdges(graph).every((edge) => edge.relationship !== "follows")).toBe(true);
  });
});

describe("§20.3: structure, never a finding", () => {
  it("marks every edge derived", () => {
    reset();
    const graph = buildWorkflowGraph({
      candidates: [
        candidate({ routes: ["/api/shared"] }),
        candidate({ routes: ["/api/shared"] }),
      ],
    });
    for (const edge of graph.edges) expect(edge.provenance).toBe("derived");
  });

  it("says nothing about vulnerability, severity or exploitability", () => {
    // §20.3: "Do not classify 'Workflow 5 is reachable directly' as a
    // confirmed vulnerability by itself." The graph is structure; V6 reasons
    // over it, with hypotheses that carry executed: false.
    reset();
    const graph = buildWorkflowGraph({
      candidates: [
        candidate({ authContext: "anonymous", routes: ["/api/shared"] }),
        candidate({ authContext: "admin", routes: ["/api/shared"] }),
      ],
    });
    const serialized = JSON.stringify(graph).toLowerCase();
    for (const word of ["vulnerab", "exploit", "severity", "critical", "insecure"]) {
      expect(serialized, `the graph used the word "${word}"`).not.toContain(word);
    }
  });

  it("uses only §20.1's six relationships", () => {
    reset();
    const graph = buildWorkflowGraph({
      candidates: [
        candidate({ authContext: "anonymous", routes: ["/api/shared"] }),
        candidate({ authContext: "admin", routes: ["/api/shared"] }),
      ],
      includeAdjacency: true,
    });
    for (const edge of graph.edges) {
      expect(WORKFLOW_RELATIONSHIPS as readonly string[]).toContain(edge.relationship);
    }
  });
});

describe("determinism", () => {
  it("produces the same graph from the same candidates", () => {
    const run = () => {
      reset();
      return JSON.stringify(
        buildWorkflowGraph({
          candidates: [
            candidate({ routes: ["/api/z", "/api/shared"] }),
            candidate({ routes: ["/api/a", "/api/shared"] }),
          ],
          includeAdjacency: true,
        }),
      );
    };
    expect(run()).toBe(run());
  });

  it("does not draw an edge from a workflow to itself", () => {
    reset();
    const only = candidate({ routes: ["/api/x"] });
    const graph = buildWorkflowGraph({ candidates: [only, only] });
    expect(graph.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });
});
