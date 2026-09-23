/**
 * The API dependency graph — build plan §20.2; dev plan BR-M3-05.
 *
 * §20.2 draws a chain: `POST /api/cart → GET /api/cart → POST
 * /api/order/validate → POST /api/order → GET /api/order/{id}`. That shape is
 * what a reader wants from an API model, and it is also the shape most easily
 * faked — four requests that happened in order look identical to four that
 * depend on each other, and §15 forbids treating the first as the second.
 *
 * So this graph is built from `depends_on` edges and nothing else. It adds no
 * inference of its own; it aggregates, counts and traverses what the API
 * model already established from value flow.
 *
 * ## Repetition strengthens an edge
 *
 * Seeing `POST /api/cart → GET /api/cart/{id}` once could be a coincidence of
 * identifiers. Seeing it four times across four separate carts is a pattern.
 * `observations` counts it and `confidence` reflects it, so a consumer can
 * ask for edges seen more than once.
 *
 * ## Cycles are normal and must not hang
 *
 * `GET /api/cart` depends on `POST /api/cart/items`, which depends on `GET
 * /api/cart`. That is an ordinary application, not a malformed graph — and a
 * traversal that assumes a tree runs forever on it. Every walk here is
 * visited-set bounded, and `cycles()` reports them rather than hiding them,
 * because a cycle in an API graph is worth a reader's attention.
 */

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  /** How many times this dependency was observed. */
  readonly observations: number;
  /**
   * 0..1, rising with repetition.
   *
   * One sighting is 0.5: real evidence, and not yet a pattern. It approaches
   * 1 asymptotically rather than reaching it, because no number of
   * observations turns an inference into an observation.
   */
  readonly confidence: number;
  /** The distinct reasons the edge was drawn, deduplicated. */
  readonly bases: readonly string[];
}

export interface DependencyGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly DependencyEdge[];
}

export interface EdgeInput {
  readonly from: string;
  readonly to: string;
  readonly basis: string;
}

/**
 * Confidence from a count.
 *
 * `1 - 1/(n+1)`: one observation gives 0.5, two 0.67, four 0.8, nine 0.9. It
 * never reaches 1 — an inferred dependency stays inferred however often it
 * recurs, and a consumer that wants certainty has to look at the evidence
 * rather than the number.
 */
export function confidenceFor(observations: number): number {
  return 1 - 1 / (observations + 1);
}

export function buildDependencyGraph(
  apis: readonly { readonly api_id: string; readonly depends_on: readonly EdgeInput[] }[],
): DependencyGraph {
  const nodes = new Set<string>();
  const byPair = new Map<
    string,
    { from: string; to: string; count: number; bases: Set<string> }
  >();

  for (const api of apis) {
    nodes.add(api.api_id);
    for (const edge of api.depends_on) {
      nodes.add(edge.to);
      const key = `${edge.to}->${api.api_id}`;
      const existing = byPair.get(key) ?? {
        // The API model records "this api depends_on that one"; the graph
        // draws the arrow the way §20.2 does, from the thing that must
        // happen first.
        from: edge.to,
        to: api.api_id,
        count: 0,
        bases: new Set<string>(),
      };
      existing.count += 1;
      existing.bases.add(edge.basis);
      byPair.set(key, existing);
    }
  }

  const edges = [...byPair.values()]
    .map((entry): DependencyEdge => ({
      from: entry.from,
      to: entry.to,
      observations: entry.count,
      confidence: confidenceFor(entry.count),
      bases: [...entry.bases].sort(),
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return { nodes: [...nodes].sort(), edges };
}

/** Everything that must happen before a node, transitively. Cycle-safe. */
export function prerequisitesOf(graph: DependencyGraph, node: string): readonly string[] {
  const seen = new Set<string>([node]);
  const queue = [node];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of graph.edges) {
      if (edge.to !== current || seen.has(edge.from)) continue;
      seen.add(edge.from);
      queue.push(edge.from);
    }
  }

  seen.delete(node);
  return [...seen].sort();
}

/**
 * Cycles in the graph, each as the nodes involved.
 *
 * Reported rather than removed. A cycle is usually an ordinary application —
 * a cart that reads itself after every write — and occasionally something a
 * reader should look at. Silently breaking it to make the graph a tree would
 * hide both.
 */
export function cycles(graph: DependencyGraph): readonly (readonly string[])[] {
  const found: string[][] = [];
  const seenCycles = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const onPath: string[] = [];
  const inPath = new Set<string>();
  const explored = new Set<string>();

  const walk = (node: string): void => {
    if (inPath.has(node)) {
      // Found one. Recorded from its entry point so the same cycle
      // discovered from three different starts is reported once.
      const start = onPath.indexOf(node);
      const cycle = onPath.slice(start);
      const key = [...cycle].sort().join(",");
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        found.push(cycle);
      }
      return;
    }
    if (explored.has(node)) return;

    inPath.add(node);
    onPath.push(node);
    for (const next of outgoing.get(node) ?? []) walk(next);
    onPath.pop();
    inPath.delete(node);
    explored.add(node);
  };

  for (const node of graph.nodes) walk(node);
  return found.map((cycle) => [...cycle]);
}

/**
 * Nodes in dependency order, cycles last.
 *
 * A topological sort that does not throw on a cycle: the acyclic part is
 * ordered and whatever remains is appended, sorted, so the output is total
 * and deterministic. Throwing would mean an ordinary application produces no
 * ordering at all.
 */
export function inDependencyOrder(graph: DependencyGraph): readonly string[] {
  const incoming = new Map<string, number>();
  for (const node of graph.nodes) incoming.set(node, 0);
  for (const edge of graph.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const ready = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([node]) => node)
    .sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const node = ready.shift() as string;
    ordered.push(node);
    for (const edge of graph.edges) {
      if (edge.from !== node) continue;
      const remaining = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, remaining);
      if (remaining === 0) {
        ready.push(edge.to);
        ready.sort();
      }
    }
  }

  const stuck = graph.nodes.filter((node) => !ordered.includes(node)).sort();
  return [...ordered, ...stuck];
}
