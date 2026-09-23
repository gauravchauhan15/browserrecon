/**
 * The workflow graph — build plan §20.1, §20.3; dev plan BR-M3-06.
 *
 * §20.1 asks for six typed relationships between workflows. BR-M3-06's
 * acceptance criterion is sharper than the plan and is the thing to hold on
 * to: *relationships derived from shared state or objects, **not
 * co-occurrence alone***.
 *
 * That rules out the easy implementation. Two workflows that happened one
 * after another are two workflows that happened one after another; drawing
 * `enables` between them asserts that the first made the second possible,
 * which a scan that visited pages in queue order has no evidence for. On a
 * site where the explorer happens to walk checkout before login, the naive
 * version says checkout enables login.
 *
 * So every edge here needs a shared *thing*: an API, a route, a state, or a
 * dependency crossing between them. `follows` is the one exception and is
 * labelled as what it is — adjacency, nothing more — so a consumer can drop
 * it wholesale.
 *
 * ## §20.3, which this graph makes tempting to violate
 *
 * "Do not classify 'Workflow 5 is reachable directly' as a confirmed
 * vulnerability by itself." Nothing here classifies anything as a
 * vulnerability. The graph is structure; V6 reasons over it, with hypotheses
 * that carry `executed: false`.
 */
import type { WorkflowCandidate } from "./candidates.js";

/** §20.1's six. */
export const WORKFLOW_RELATIONSHIPS = [
  "enables",
  "requires",
  "follows",
  "returns_to",
  "shares_state_with",
  "depends_on",
] as const;

export type WorkflowRelationship = (typeof WORKFLOW_RELATIONSHIPS)[number];

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly relationship: WorkflowRelationship;
  /** The shared thing that justified it. Never "they happened in order". */
  readonly basis: string;
  /** Always derived. A structural inference is not an observation. */
  readonly provenance: "derived";
  /**
   * How much the edge claims.
   *
   * `follows` is adjacency and nothing more, so it is weakest by
   * construction — a consumer that wants only structural edges filters it
   * out, which is why it is typed separately rather than omitted.
   */
  readonly confidence: number;
}

export interface WorkflowGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly WorkflowEdge[];
}

/** State transitions, as the graph needs them. */
export interface TransitionForGraph {
  readonly from: string;
  readonly to: string;
  readonly sequence: number;
}

export interface BuildGraphInput {
  readonly candidates: readonly WorkflowCandidate[];
  readonly transitions?: readonly TransitionForGraph[] | undefined;
  /** Include `follows` edges. Off by default — see the module note. */
  readonly includeAdjacency?: boolean | undefined;
}

const CONFIDENCE: Readonly<Record<WorkflowRelationship, number>> = {
  depends_on: 0.9,
  requires: 0.8,
  enables: 0.7,
  shares_state_with: 0.6,
  returns_to: 0.5,
  follows: 0.2,
};

function span(candidate: WorkflowCandidate): { first: number; last: number } {
  const sequences = candidate.events.map((event) => event.sequence);
  return { first: Math.min(...sequences), last: Math.max(...sequences) };
}

/**
 * Build the graph.
 *
 * Every rule below names the shared thing it found. A rule that could not
 * name one would be co-occurrence wearing a label, which is what the
 * acceptance criterion forbids.
 */
export function buildWorkflowGraph(input: BuildGraphInput): WorkflowGraph {
  const candidates = [...input.candidates].sort((a, b) => span(a).first - span(b).first);
  const edges: WorkflowEdge[] = [];

  const add = (
    from: string,
    to: string,
    relationship: WorkflowRelationship,
    basis: string,
  ): void => {
    if (from === to) return;
    const already = edges.find(
      (edge) => edge.from === from && edge.to === to && edge.relationship === relationship,
    );
    if (already !== undefined) return;
    edges.push({
      from,
      to,
      relationship,
      basis,
      provenance: "derived",
      confidence: CONFIDENCE[relationship],
    });
  };

  for (const [index, earlier] of candidates.entries()) {
    const earlierApis = new Set(earlier.events.map((event) => event.apiId));
    const earlierRoutes = new Set(earlier.routes);
    const earlierSpan = span(earlier);

    for (const later of candidates.slice(index + 1)) {
      const laterSpan = span(later);

      // depends_on: an API in the later workflow needed one from the
      // earlier. The strongest possible link, because it came from a value
      // that actually flowed.
      const dependency = later.events.find((event) =>
        event.dependsOn.some((target) => earlierApis.has(target)),
      );
      if (dependency !== undefined) {
        add(
          later.workflow_id,
          earlier.workflow_id,
          "depends_on",
          `${dependency.apiId} depends on an API produced by ${earlier.workflow_id}`,
        );
        // The mirror, which is what a reader traversing forwards wants.
        add(
          earlier.workflow_id,
          later.workflow_id,
          "enables",
          `produced the API ${dependency.apiId} depends on`,
        );
        continue;
      }

      // requires: the later workflow ran under an auth context the earlier
      // one established. Shared state, not adjacency.
      if (
        earlier.authContext !== later.authContext &&
        later.authContext !== "anonymous" &&
        earlier.authContext === "anonymous"
      ) {
        add(
          later.workflow_id,
          earlier.workflow_id,
          "requires",
          `runs as ${later.authContext} where ${earlier.workflow_id} ran anonymously`,
        );
      }

      // shares_state_with: the same route template in both. A weaker link
      // than a dependency and a real one — two workflows touching
      // `/api/cart/{id}` are working on the same thing.
      const shared = [...later.routes].filter((route) => earlierRoutes.has(route));
      if (shared.length > 0) {
        add(
          earlier.workflow_id,
          later.workflow_id,
          "shares_state_with",
          `both touch ${shared.slice(0, 3).join(", ")}`,
        );
      }

      // returns_to: the later workflow ends where the earlier began. A loop
      // in the application, which is worth seeing.
      if (
        later.routes.length > 0 &&
        earlier.routes.length > 0 &&
        later.routes[later.routes.length - 1] === earlier.routes[0] &&
        shared.length > 0
      ) {
        add(
          later.workflow_id,
          earlier.workflow_id,
          "returns_to",
          `ends at ${earlier.routes[0]}, where ${earlier.workflow_id} began`,
        );
      }

      // A state transition crossing from one span into the other: the
      // application changed state between them, which links them through
      // the state graph rather than through the clock.
      const crossing = (input.transitions ?? []).find(
        (transition) =>
          transition.sequence > earlierSpan.last && transition.sequence <= laterSpan.first,
      );
      if (crossing !== undefined) {
        add(
          earlier.workflow_id,
          later.workflow_id,
          "enables",
          `the application moved from ${crossing.from} to ${crossing.to} between them`,
        );
      }
    }
  }

  // `follows` last and opt-in. It is adjacency, which the acceptance
  // criterion excludes as a *basis* — so it is offered as a separately typed
  // and separately weak edge rather than mixed in with the structural ones.
  if (input.includeAdjacency === true) {
    for (const [index, earlier] of candidates.entries()) {
      const next = candidates[index + 1];
      if (next === undefined) continue;
      add(
        earlier.workflow_id,
        next.workflow_id,
        "follows",
        "ran immediately before it — adjacency only, no shared state",
      );
    }
  }

  return {
    nodes: candidates.map((candidate) => candidate.workflow_id).sort(),
    edges: edges.sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.relationship.localeCompare(b.relationship),
    ),
  };
}

/** Edges that rest on shared state rather than on order. */
export function structuralEdges(graph: WorkflowGraph): readonly WorkflowEdge[] {
  return graph.edges.filter((edge) => edge.relationship !== "follows");
}
