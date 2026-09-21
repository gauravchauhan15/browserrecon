import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { describe, expect, it } from "vitest";
import {
  createAnalysisPipeline,
  createTreeSitterAnalyzer,
  discoverChunks,
  reconcile,
  unfetchedChunks,
  type RuntimeEndpoint,
  type StaticCandidate,
} from "./index.js";

const analyzer = createTreeSitterAnalyzer();

describe("§10B.9: bounds, and a scan that survives them", () => {
  it("refuses an oversized asset before parsing it", async () => {
    // The cheap gate. The spike measured RSS reaching ~28x the source, so a
    // 20 MB bundle wants ~560 MB; refusing costs one candidate list.
    const pipeline = createAnalysisPipeline({ analyzer, bounds: { maxAssetBytes: 1_000 } });
    const { result } = await pipeline.analyze({ script: "big.js", source: "x".repeat(5_000) });

    expect(result.status).toBe("failed");
    expect(result.limitReason).toContain("size_limit");
    // `failed`, not `partial`: nothing was analysed, and calling it partial
    // would suggest the findings are a subset rather than absent.
    expect(result.apis).toEqual([]);
  });

  it("stops once the whole-scan budget is spent", async () => {
    let clock = 0;
    const pipeline = createAnalysisPipeline({
      analyzer,
      bounds: { totalBudgetMs: 100 },
      now: () => clock,
    });

    expect(
      (await pipeline.analyze({ script: "a.js", source: 'fetch("/api/a");' })).result.status,
    ).toBe("complete");
    clock = 5_000;
    const late = await pipeline.analyze({ script: "b.js", source: 'fetch("/api/b");' });
    expect(late.result.limitReason).toContain("total_budget");
  });

  it("returns a result for a cancelled scan rather than throwing", async () => {
    const controller = new AbortController();
    controller.abort();
    const pipeline = createAnalysisPipeline({ analyzer, signal: controller.signal });
    const { result } = await pipeline.analyze({ script: "a.js", source: 'fetch("/api/a");' });
    expect(result.limitReason).toContain("cancelled");
  });

  it("never throws, whatever the asset", async () => {
    // A caller that has to remember to catch will forget, and what it
    // forgets is one bundle taking down a scan that had already succeeded.
    const pipeline = createAnalysisPipeline({ analyzer });
    for (const source of ["", "{{{{", "\\uD800", "x".repeat(100_000)]) {
      await expect(pipeline.analyze({ script: "a.js", source })).resolves.toBeDefined();
    }
  });

  it("uses one limit-reason vocabulary", async () => {
    const pipeline = createAnalysisPipeline({ analyzer, bounds: { maxAssetBytes: 10 } });
    const { result } = await pipeline.analyze({ script: "a.js", source: "x".repeat(100) });
    expect(result.limitReason?.split(":")[0]).toBe("size_limit");
  });

  it("keeps every other bound when the caller sets one", async () => {
    // `{...DEFAULTS, ...given}` puts an explicit undefined back over a
    // default, so a caller passing one field would silently lose the rest.
    const pipeline = createAnalysisPipeline({ analyzer, bounds: { timeBudgetMs: 5_000 } });
    const { result } = await pipeline.analyze({
      script: "a.js",
      source: "x".repeat(20_000_000),
    });
    expect(result.limitReason).toContain("size_limit");
  });
});

describe("what the bounds actually bound", () => {
  it("refuses an oversized asset whatever else is configured", async () => {
    // The correction that removed the worker: tree-sitter allocates its
    // tree in native memory, so a V8 heap ceiling never saw it — a 16 MB
    // ceiling parsed 4.8 MB to completion while RSS grew 342 MB. The size
    // gate is the memory bound, and it is the one that is always on.
    const pipeline = createAnalysisPipeline({ analyzer, bounds: { maxAssetBytes: 2_000 } });
    const { result, bounded } = await pipeline.analyze({
      script: "a.js",
      source: 'fetch("/api/x");'.repeat(1_000),
    });

    expect(bounded).toBe("size_limit");
    expect(result.status).toBe("failed");
  });

  it("counts what it refused, by reason", async () => {
    // §45's no-silent-loss rule: a scan that skipped four bundles has to be
    // able to say so, or its coverage number is quietly wrong.
    const pipeline = createAnalysisPipeline({ analyzer, bounds: { maxAssetBytes: 100 } });
    for (const name of ["a.js", "b.js", "c.js"]) {
      await pipeline.analyze({ script: name, source: "x".repeat(500) });
    }
    expect(pipeline.refused).toEqual({ size_limit: 3 });
  });

  it("reports nothing refused on a clean run", async () => {
    const pipeline = createAnalysisPipeline({ analyzer });
    await pipeline.analyze({ script: "a.js", source: 'fetch("/api/a");' });
    expect(pipeline.refused).toEqual({});
  });

  it("handles a malformed bundle without a worker, because the parser does not throw", async () => {
    // §10B.9's "malformed bundle" half. tree-sitter returns a partial tree
    // rather than raising, which is why isolation was not needed for it.
    const pipeline = createAnalysisPipeline({ analyzer });
    const { result } = await pipeline.analyze({
      script: "broken.js",
      source: 'fetch("/api/found");\nfunction a(){ fetch("/api/cut',
    });

    expect(result.status).toBe("partial");
    expect(result.apis.map((a) => a.path)).toContain("/api/found");
  });
});

/** Build a log without a browser, as the API model's tests do. */
let sequence = 0;
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

describe("dynamic chunk discovery (§10B.6)", () => {
  it("marks a chunk that arrived after load as lazy", () => {
    // The signal that makes a chunk interesting: something had to happen
    // before the application wanted this code.
    const chunks = discoverChunks([
      event("navigation_committed", { url: "https://shop.example.com/" }),
      event("network_request", {
        url: "https://shop.example.com/main.js",
        resourceType: "Script",
        initiator: { type: "parser" },
      }),
      event("page_loaded", { url: "https://shop.example.com/" }),
      event("interaction", { interaction_id: "int_0001" }),
      event("network_request", {
        url: "https://shop.example.com/admin.chunk.js",
        resourceType: "Script",
        initiator: { type: "script" },
      }),
    ]);

    const main = chunks.find((c) => c.url.endsWith("main.js"));
    const admin = chunks.find((c) => c.url.endsWith("admin.chunk.js"));
    expect(main?.lazy).toBe(false);
    expect(admin?.lazy).toBe(true);
    expect(admin?.source).toBe("dynamic_import");
    expect(admin?.afterInteraction).toBe("int_0001");
  });

  it("tells a dynamic import from a script tag by its initiator", () => {
    const chunks = discoverChunks([
      event("network_request", {
        url: "https://shop.example.com/a.js",
        resourceType: "Script",
        initiator: { type: "parser" },
      }),
      event("network_request", {
        url: "https://shop.example.com/b.js",
        resourceType: "Script",
        initiator: { type: "script" },
      }),
    ]);
    expect(chunks.find((c) => c.url.endsWith("a.js"))?.source).toBe("document_script");
    expect(chunks.find((c) => c.url.endsWith("b.js"))?.source).toBe("dynamic_import");
  });

  it("records a preload hint as known but not loaded", () => {
    // A free list of code paths, including screens this scan never reached.
    const chunks = discoverChunks([
      event("dom_snapshot", {
        links: [
          { rel: "modulepreload", href: "https://shop.example.com/checkout.chunk.js" },
          { rel: "stylesheet", href: "https://shop.example.com/app.css" },
        ],
      }),
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.loaded).toBe(false);
    expect(chunks[0]?.source).toBe("modulepreload");
    expect(unfetchedChunks(chunks)).toHaveLength(1);
  });

  it("upgrades a hinted chunk once it is actually fetched, never the reverse", () => {
    const hintFirst = discoverChunks([
      event("dom_snapshot", {
        links: [{ rel: "modulepreload", href: "https://shop.example.com/x.js" }],
      }),
      event("network_request", {
        url: "https://shop.example.com/x.js",
        resourceType: "Script",
        initiator: { type: "script" },
      }),
    ]);
    expect(hintFirst[0]?.loaded).toBe(true);

    const loadFirst = discoverChunks([
      event("network_request", {
        url: "https://shop.example.com/x.js",
        resourceType: "Script",
        initiator: { type: "script" },
      }),
      event("dom_snapshot", {
        links: [{ rel: "modulepreload", href: "https://shop.example.com/x.js" }],
      }),
    ]);
    expect(loadFirst[0]?.loaded).toBe(true);
  });

  it("ignores non-script resources", () => {
    const chunks = discoverChunks([
      event("network_request", {
        url: "https://shop.example.com/app.css",
        resourceType: "Stylesheet",
        initiator: { type: "parser" },
      }),
      event("network_request", {
        url: "https://shop.example.com/api/cart",
        resourceType: "Fetch",
        initiator: { type: "script" },
      }),
    ]);
    expect(chunks).toEqual([]);
  });

  it("restarts the lazy question at each navigation", () => {
    const chunks = discoverChunks([
      event("navigation_committed", { url: "https://shop.example.com/a" }),
      event("page_loaded", { url: "https://shop.example.com/a" }),
      event("navigation_committed", { url: "https://shop.example.com/b" }),
      event("network_request", {
        url: "https://shop.example.com/b.js",
        resourceType: "Script",
        initiator: { type: "parser" },
      }),
    ]);
    // Loaded during the second document's parse, not after it: not lazy.
    expect(chunks[0]?.lazy).toBe(false);
    expect(chunks[0]?.page).toBe("https://shop.example.com/b");
  });
});

describe("static ↔ runtime reconciliation (§10A.3)", () => {
  const candidate = (path: string, over: Partial<StaticCandidate> = {}): StaticCandidate => ({
    path,
    confidence: "high",
    sources: [{ script: "https://shop.example.com/app.js", line: 182 }],
    ...over,
  });

  const endpoint = (pathTemplate: string, id = "api_0001"): RuntimeEndpoint => ({
    api_id: id,
    method: "GET",
    url: `https://shop.example.com${pathTemplate}`,
    identity: { origin: "https://shop.example.com", pathTemplate },
  });

  it("marks a candidate the scan actually called as observed", () => {
    const result = reconcile([candidate("/api/orders")], [endpoint("/api/orders")]);
    expect(result.endpoints[0]?.status).toBe("observed");
    expect(result.endpoints[0]?.apiId).toBe("api_0001");
  });

  it("keeps the static source after confirmation", () => {
    // §10.3: sources merge, they do not replace. Dropping the file and line
    // on confirmation loses it exactly for the endpoints that matter most.
    const result = reconcile([candidate("/api/orders")], [endpoint("/api/orders")]);
    expect(result.endpoints[0]?.provenance).toEqual([
      "javascript_static_analysis",
      "runtime_network",
    ]);
    expect(result.endpoints[0]?.staticSources[0]).toEqual({
      script: "https://shop.example.com/app.js",
      line: 182,
    });
  });

  it("matches the three spellings of one endpoint", () => {
    // The framework writes `{id}`, the developer writes `:id`, the browser
    // fetches `42`. Without this a covered endpoint is reported as a gap —
    // the most misleading thing a coverage number can do.
    for (const written of ["/api/orders/{id}", "/api/orders/:id", "/api/orders/42"]) {
      const result = reconcile([candidate(written)], [endpoint("/api/orders/{id}")]);
      expect(result.endpoints[0]?.status, written).toBe("observed");
    }
  });

  it("marks a candidate reached under a configured base as correlated", () => {
    const result = reconcile([candidate("/orders")], [endpoint("/api/v2/orders")], {
      basePaths: ["/api/v2"],
    });
    expect(result.endpoints[0]?.status).toBe("correlated");
    expect(result.endpoints[0]?.correlationBasis).toContain("/api/v2");
  });

  it("leaves an unreached candidate unobserved, which is the valuable part", () => {
    // Not a failure. It is the surface the scan could not get to, which is
    // what a coverage gap queue is built from.
    const result = reconcile(
      [candidate("/api/admin/users"), candidate("/api/orders")],
      [endpoint("/api/orders")],
    );
    const admin = result.endpoints.find((e) => e.path === "/api/admin/users");
    expect(admin?.status).toBe("unobserved");
    expect(admin?.provenance).toEqual(["javascript_static_analysis"]);
    expect(admin?.apiId).toBeUndefined();
  });

  it("counts observations no candidate predicted", () => {
    // The other side of the ledger: surface the bundle never mentioned.
    const result = reconcile(
      [candidate("/api/orders")],
      [endpoint("/api/orders"), endpoint("/api/secret", "api_0002")],
    );
    expect(result.runtimeOnly).toBe(1);
  });

  it("reports counts by status", () => {
    const result = reconcile(
      [candidate("/api/a"), candidate("/api/b"), candidate("/api/c")],
      [endpoint("/api/a")],
    );
    expect(result.counts).toEqual({ observed: 1, correlated: 0, unobserved: 2 });
  });

  it("sorts, so a coverage report diffs cleanly", () => {
    const result = reconcile([candidate("/api/z"), candidate("/api/a")], []);
    expect(result.endpoints.map((e) => e.path)).toEqual(["/api/a", "/api/z"]);
  });

  it("does not match two genuinely different endpoints", () => {
    // Shape matching must not over-collapse: `/api/orders` and
    // `/api/invoices` are not one endpoint written two ways.
    const result = reconcile([candidate("/api/invoices")], [endpoint("/api/orders")]);
    expect(result.endpoints[0]?.status).toBe("unobserved");
  });
});
