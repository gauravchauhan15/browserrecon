import { describe, expect, it } from "vitest";
import { createRegistry } from "./registry.js";

describe("one entry, every source", () => {
  it("merges the same URL found by three sources", async () => {
    // "Found by the crawler AND written in the JavaScript AND linked from
    // the page" is a different fact from any single sighting.
    const registry = createRegistry();
    registry.add("https://a.test/api/orders", { source: "katana" });
    registry.add("https://a.test/api/orders", { source: "js_mining", foundOn: "/app.js" });
    registry.add("https://a.test/api/orders", { source: "dom_link", foundOn: "/orders" });

    const entry = registry.get("https://a.test/api/orders");
    expect(entry?.sources.map((s) => s.source)).toEqual(["katana", "js_mining", "dom_link"]);
    expect(registry.all()).toHaveLength(1);
  });

  it("does not count one source twice", async () => {
    // A crawler listing a URL twice is still one source saying one thing;
    // counting it would inflate the corroboration multi-source agreement is
    // supposed to represent.
    const registry = createRegistry();
    registry.add("https://a.test/x", { source: "katana" });
    registry.add("https://a.test/x", { source: "katana", foundOn: "/elsewhere" });
    expect(registry.get("https://a.test/x")?.sources).toHaveLength(1);
  });

  it("treats a fragment-only difference as the same candidate", async () => {
    const registry = createRegistry();
    registry.add("https://a.test/p", { source: "dom_link" });
    registry.add("https://a.test/p#section", { source: "dom_link" });
    expect(registry.all()).toHaveLength(1);
  });

  it("refuses anything that is not a page", async () => {
    const registry = createRegistry();
    expect(registry.add("mailto:a@b.test", { source: "dom_link" })).toBeUndefined();
    expect(registry.all()).toHaveLength(0);
  });
});

describe("status is a transition, not a flag", () => {
  it("starts discovered and records what observed it", async () => {
    // §10C: a URL a crawler listed is not evidence of anything until the
    // browser visited it (§5A.3).
    const registry = createRegistry();
    registry.add("https://a.test/x", { source: "katana" });
    expect(registry.get("https://a.test/x")?.status).toBe("discovered");

    registry.markObserved("https://a.test/x", "visited at depth 1");
    expect(registry.get("https://a.test/x")).toMatchObject({
      status: "observed",
      statusReason: "visited at depth 1",
    });
  });

  it("records why something was left unvisited", async () => {
    const registry = createRegistry();
    registry.add("https://a.test/x", { source: "katana" });
    registry.markUnobserved("https://a.test/x", "template saturated");
    expect(registry.get("https://a.test/x")?.statusReason).toBe("template saturated");
  });

  it("does not downgrade something already observed", async () => {
    // A URL visited once stays observed even if a later pass skips it.
    const registry = createRegistry();
    registry.add("https://a.test/x", { source: "katana" });
    registry.markObserved("https://a.test/x", "visited");
    registry.markUnobserved("https://a.test/x", "skipped on a later pass");
    expect(registry.get("https://a.test/x")?.status).toBe("observed");
  });
});

describe("what the registry can answer", () => {
  it("counts discovered against observed, which is the coverage number", async () => {
    const registry = createRegistry();
    for (let i = 0; i < 5; i += 1) registry.add(`https://a.test/p/${i}`, { source: "katana" });
    registry.markObserved("https://a.test/p/0", "visited");
    registry.markObserved("https://a.test/p/1", "visited");

    expect(registry.stats).toMatchObject({ total: 5, observed: 2, discovered: 3 });
  });

  it("counts per source, which sums to more than the total by design", async () => {
    const registry = createRegistry();
    registry.add("https://a.test/x", { source: "katana" });
    registry.add("https://a.test/x", { source: "dom_link" });
    registry.add("https://a.test/y", { source: "katana" });

    expect(registry.stats.total).toBe(2);
    expect(registry.stats.bySource.get("katana")).toBe(2);
    expect(registry.stats.bySource.get("dom_link")).toBe(1);
  });

  it("groups by route template", async () => {
    const registry = createRegistry();
    for (const id of [1, 2, 3]) registry.add(`https://a.test/p/${id}`, { source: "katana" });
    registry.add("https://a.test/about", { source: "dom_link" });

    const grouped = registry.byTemplate();
    expect(grouped.get("https://a.test/p/{id}")).toHaveLength(3);
    expect(grouped.get("https://a.test/about")).toHaveLength(1);
    expect(registry.stats.templates).toBe(2);
  });

  it("lists entries in a reproducible order", async () => {
    const registry = createRegistry();
    for (const path of ["/z", "/a", "/m"])
      registry.add(`https://a.test${path}`, { source: "katana" });
    expect(registry.all().map((e) => e.url)).toEqual([
      "https://a.test/a",
      "https://a.test/m",
      "https://a.test/z",
    ]);
  });
});
