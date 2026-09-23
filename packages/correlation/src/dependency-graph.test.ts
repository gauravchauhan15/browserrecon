import { describe, expect, it } from "vitest";
import {
  buildDependencyGraph,
  confidenceFor,
  cycles,
  inDependencyOrder,
  prerequisitesOf,
} from "./index.js";

const api = (id: string, dependsOn: { to: string; basis?: string }[] = []) => ({
  api_id: id,
  depends_on: dependsOn.map((edge) => ({
    from: id,
    to: edge.to,
    basis: edge.basis ?? "a value flowed",
  })),
});

describe("§20.2: the dependency chain", () => {
  it("reproduces the plan's own example", () => {
    // POST /api/cart -> GET /api/cart -> POST /api/order/validate ->
    // POST /api/order -> GET /api/order/{id}
    const graph = buildDependencyGraph([
      api("cart_create"),
      api("cart_read", [{ to: "cart_create" }]),
      api("order_validate", [{ to: "cart_read" }]),
      api("order_create", [{ to: "order_validate" }]),
      api("order_read", [{ to: "order_create" }]),
    ]);

    expect(graph.nodes).toHaveLength(5);
    // The arrow points the way §20.2 draws it: from what must happen first.
    expect(graph.edges.find((e) => e.to === "cart_read")?.from).toBe("cart_create");
    expect(prerequisitesOf(graph, "order_read")).toEqual([
      "cart_create",
      "cart_read",
      "order_create",
      "order_validate",
    ]);
  });

  it("orders nodes so prerequisites come first", () => {
    const graph = buildDependencyGraph([
      api("third", [{ to: "second" }]),
      api("second", [{ to: "first" }]),
      api("first"),
    ]);
    expect(inDependencyOrder(graph)).toEqual(["first", "second", "third"]);
  });

  it("adds no edge the input did not carry", () => {
    // §15. This graph aggregates and traverses; it infers nothing. Four
    // requests that happened in order look identical to four that depend on
    // each other, and only one of those is a dependency.
    const graph = buildDependencyGraph([api("a"), api("b"), api("c")]);
    expect(graph.edges).toEqual([]);
  });
});

describe("repetition strengthens an edge", () => {
  it("counts observations and raises confidence", () => {
    // Seeing a dependency once could be a coincidence of identifiers; seeing
    // it four times across four carts is a pattern.
    const once = buildDependencyGraph([api("b", [{ to: "a" }])]);
    const often = buildDependencyGraph([
      api("b", [{ to: "a" }, { to: "a" }, { to: "a" }, { to: "a" }]),
    ]);

    expect(once.edges[0]?.observations).toBe(1);
    expect(often.edges[0]?.observations).toBe(4);
    expect(often.edges[0]?.confidence).toBeGreaterThan(once.edges[0]?.confidence ?? 1);
  });

  it("never reaches certainty, however many times it is seen", () => {
    // An inferred dependency stays inferred. A consumer that wants certainty
    // has to read the evidence, not the number.
    expect(confidenceFor(1)).toBe(0.5);
    expect(confidenceFor(1_000)).toBeLessThan(1);
  });

  it("keeps the distinct reasons, deduplicated", () => {
    const graph = buildDependencyGraph([
      api("b", [
        { to: "a", basis: "the `order_id` flowed" },
        { to: "a", basis: "the `order_id` flowed" },
        { to: "a", basis: "the `cart_id` flowed" },
      ]),
    ]);
    expect(graph.edges[0]?.bases).toEqual(["the `cart_id` flowed", "the `order_id` flowed"]);
  });
});

describe("cycles are normal and must not hang", () => {
  const cyclic = () =>
    buildDependencyGraph([
      api("cart_read", [{ to: "cart_write" }]),
      api("cart_write", [{ to: "cart_read" }]),
    ]);

  it("traverses a cycle without looping forever", () => {
    // `GET /api/cart` depends on `POST /api/cart/items`, which depends on
    // `GET /api/cart`. An ordinary application, and a traversal that assumes
    // a tree runs forever on it.
    expect(prerequisitesOf(cyclic(), "cart_read")).toEqual(["cart_write"]);
  });

  it("reports the cycle rather than hiding it", () => {
    const found = cycles(cyclic());
    expect(found).toHaveLength(1);
    expect([...(found[0] ?? [])].sort()).toEqual(["cart_read", "cart_write"]);
  });

  it("reports one cycle once, however many nodes it is found from", () => {
    const found = cycles(
      buildDependencyGraph([
        api("a", [{ to: "c" }]),
        api("b", [{ to: "a" }]),
        api("c", [{ to: "b" }]),
      ]),
    );
    expect(found).toHaveLength(1);
  });

  it("still orders the acyclic part when a cycle exists", () => {
    // Throwing would mean an ordinary application produces no ordering at
    // all. The acyclic part is ordered and the rest appended, sorted, so the
    // output is total and deterministic.
    const graph = buildDependencyGraph([
      api("standalone"),
      api("x", [{ to: "y" }]),
      api("y", [{ to: "x" }]),
    ]);
    const order = inDependencyOrder(graph);

    expect(order).toHaveLength(3);
    expect(order[0]).toBe("standalone");
    expect(order.slice(1).sort()).toEqual(["x", "y"]);
  });

  it("finds no cycle where there is none", () => {
    expect(cycles(buildDependencyGraph([api("b", [{ to: "a" }])]))).toEqual([]);
  });
});

describe("determinism", () => {
  it("sorts nodes and edges", () => {
    const graph = buildDependencyGraph([
      api("zebra", [{ to: "alpha" }]),
      api("alpha"),
      api("middle", [{ to: "alpha" }]),
    ]);
    expect(graph.nodes).toEqual(["alpha", "middle", "zebra"]);
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "alpha->middle",
      "alpha->zebra",
    ]);
  });
});
