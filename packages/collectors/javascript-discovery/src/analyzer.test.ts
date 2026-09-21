import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ORIGIN_KINDS,
  REQUEST_LIBRARIES,
  createTreeSitterAnalyzer,
  locateOffset,
  type AnalyzeInput,
  type JSAnalyzer,
} from "./index.js";

/**
 * The §10A.1 boundary, and a contract any implementation must satisfy.
 *
 * `runAnalyzerContract` is exported in spirit: when BR-M2-19's jsluice CLI
 * analyzer lands, it runs the same block. A contract only one implementation
 * is held to is a description of that implementation.
 */

const analyzer = createTreeSitterAnalyzer();

const analyze = (source: string, pageOrigin = "https://shop.example.com") =>
  analyzer.analyze({ script: "https://shop.example.com/app.js", source, pageOrigin });

describe("the interface exposes no parser types", () => {
  it("names no parser in any exported signature", () => {
    // §10A.1's critical boundary, checked mechanically rather than promised.
    // The parser is the dependency most likely to be replaced — jsluice is a
    // Go binary, tree-sitter is a native addon — and a consumer that had
    // learned its node types would be rewritten each time.
    // Comments are stripped first. The interface's own documentation has to
    // be able to *name* the parser it is isolating — the same lesson as
    // tests/meta/no-solver.test.ts, where a scan that forbade the words made
    // the refusal impossible to document.
    const declaration = readFileSync(
      fileURLToPath(new URL("./analyzer.ts", import.meta.url)),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

    for (const leak of ["tree-sitter", "SyntaxNode", "TreeCursor", "jsluice", "acorn"]) {
      expect(declaration, `${leak} appears in the interface's code`).not.toContain(leak);
    }
    // And no import of any kind: the interface is types only.
    expect(declaration).not.toMatch(/^\s*import\s/m);
  });

  it("keeps the parser import inside the implementation", () => {
    const implementation = readFileSync(
      fileURLToPath(new URL("./tree-sitter-analyzer.ts", import.meta.url)),
      "utf8",
    );
    expect(implementation).toContain('from "tree-sitter"');
  });
});

describe("the analyzer contract", () => {
  const empty: AnalyzeInput = { script: "x.js", source: "" };

  it("identifies itself and its rule version", () => {
    // The rule version is part of the analysis cache key (§10B.8): a cached
    // result from an older ruleset must not be served after the rules
    // improve, or the improvement never reaches an already-scanned bundle.
    expect(analyzer.name).not.toBe("");
    expect(analyzer.ruleVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("answers every extraction method on empty input", () => {
    const methods: (keyof JSAnalyzer)[] = [
      "extractOrigins",
      "extractUrls",
      "extractApiCandidates",
      "extractRouteCandidates",
      "extractRequestPatterns",
      "extractConfigCandidates",
    ];
    for (const method of methods) {
      const result = (analyzer[method] as (input: AnalyzeInput) => unknown[])(empty);
      expect(Array.isArray(result), method).toBe(true);
      expect(result, method).toHaveLength(0);
    }
  });

  it("reports duration and size on every result", () => {
    // §10B.9's budget accounting needs both, on the successful path too.
    const result = analyze('fetch("/api/x");');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.bytes).toBe(16);
    expect(result.status).toBe("complete");
  });

  it("locates a byte offset as an editor counts", () => {
    const source = "a\nbb\nccc";
    expect(locateOffset(source, 0)).toEqual({ line: 1, column: 1 });
    expect(locateOffset(source, 2)).toEqual({ line: 2, column: 1 });
    expect(locateOffset(source, 5)).toEqual({ line: 3, column: 1 });
    // Out of range clamps rather than throwing: an offset from a stale
    // stack trace must not take down an analysis.
    expect(locateOffset(source, 9_999).line).toBe(3);
    expect(locateOffset(source, -5)).toEqual({ line: 1, column: 1 });
  });

  it("uses closed vocabularies", () => {
    expect(ORIGIN_KINDS).toContain("first_party");
    expect(ORIGIN_KINDS).toContain("unknown");
    expect(REQUEST_LIBRARIES).toContain("fetch");
    expect(REQUEST_LIBRARIES).toContain("unknown");
  });
});

describe("position decides confidence, not shape", () => {
  it("rates a literal in a request position high", () => {
    const result = analyze('fetch("/api/orders");');
    expect(result.apis[0]?.path).toBe("/api/orders");
    expect(result.apis[0]?.confidence).toBe("high");
  });

  it("rates the same string sitting loose low", () => {
    // The string is identical; what differs is what the code does with it,
    // which is the only real evidence static analysis has.
    const result = analyze('const messages = ["/api/orders", "not a path"];');
    expect(result.apis[0]?.path).toBe("/api/orders");
    expect(result.apis[0]?.confidence).toBe("low");
  });

  it("does not let a loose duplicate weaken a confident sighting", () => {
    const result = analyze('const list = ["/api/orders"];\nfetch("/api/orders");');
    expect(result.apis).toHaveLength(1);
    expect(result.apis[0]?.confidence).toBe("high");
  });

  it("ignores a path inside a comment", () => {
    // The failure a regex over the source text cannot avoid.
    const result = analyze('// see /api/legacy/orders for the old one\nfetch("/api/orders");');
    expect(result.apis.map((a) => a.path)).toEqual(["/api/orders"]);
  });
});

describe("request construction (§10A.5)", () => {
  it("captures fetch with its method and body expression", () => {
    const result = analyze(
      'fetch("/api/orders", { method: "POST", body: JSON.stringify(payload) });',
    );
    expect(result.requests[0]).toMatchObject({
      library: "fetch",
      method: "POST",
      urlLiteral: "/api/orders",
      bodyExpression: "JSON.stringify(payload)",
    });
  });

  it("captures a templated URL as a parameterised path", () => {
    // §10A.3's own example, and the commonest way modern code names an
    // endpoint. Before this it produced a request pattern and no API
    // candidate — the URL was "not a literal", so nothing downstream saw it.
    const result = analyze("fetch(`/api/orders/${orderId}`);");
    expect(result.apis[0]?.path).toBe("/api/orders/{orderId}");
    expect(result.apis[0]?.confidence).toBe("high");
  });

  it("names the parameter after the identifier where there is one", () => {
    const result = analyze("fetch(`/api/users/${userId}/roles`);");
    expect(result.apis[0]?.path).toBe("/api/users/{userId}/roles");
  });

  it("falls back to {param} for an expression that is not a name", () => {
    // §10A.5: do not fabricate what cannot be resolved. The text of
    // `${a.b ? c : d}` is not a parameter name.
    const result = analyze("fetch(`/api/users/${a.b ? c : d}/roles`);");
    expect(result.apis[0]?.path).toBe("/api/users/{param}/roles");
  });

  it("keeps the expression verbatim, never a guess at its value", () => {
    const result = analyze("fetch(`/api/orders/${orderId}`);");
    expect(result.requests[0]?.urlExpression).toBe("`/api/orders/${orderId}`");
    expect(result.requests[0]?.urlLiteral).toBeUndefined();
  });

  it("records no path when the base is unknown", () => {
    // `${base}/api/items` could resolve to anything. Claiming `/api/items`
    // would assert a path that may not exist; the request pattern keeps the
    // expression so runtime can settle it.
    const result = analyze("fetch(`${base}/api/items`);");
    expect(result.apis).toHaveLength(0);
    expect(result.requests[0]?.urlExpression).toContain("${base}");
  });

  it("recognises axios-style verb methods on a wrapper", () => {
    // Demanding the object literally be `axios` would miss almost every
    // real codebase, where it is `api`, `client` or `http`.
    for (const call of [
      'api.get("/api/a")',
      'client.post("/api/b")',
      'http.delete("/api/c")',
      'axios.put("/api/d")',
    ]) {
      const result = analyze(`${call};`);
      expect(result.requests[0]?.library, call).toBe("axios");
      expect(result.requests[0]?.method, call).toBeTruthy();
    }
  });

  it("recognises XMLHttpRequest.open, where the URL is the second argument", () => {
    const result = analyze('xhr.open("PUT", "/api/profile");');
    expect(result.requests[0]).toMatchObject({
      library: "xhr",
      method: "PUT",
      urlLiteral: "/api/profile",
    });
  });

  it("recognises WebSocket and EventSource", () => {
    const result = analyze(
      'new WebSocket("wss://live.example.com/feed");\nnew EventSource("/api/stream");',
    );
    expect(result.requests.map((r) => r.library).sort()).toEqual(["eventsource", "websocket"]);
  });

  it("does not treat an ordinary method call as a request", () => {
    const result = analyze('logger.post("a message");\narray.get(0);');
    expect(result.requests).toHaveLength(0);
  });
});

describe("origins (§10A.4)", () => {
  it("classifies the page's own origin as first-party", () => {
    const result = analyze('fetch("https://shop.example.com/api/x");');
    expect(result.origins[0]).toMatchObject({
      origin: "https://shop.example.com",
      kind: "first_party",
    });
  });

  it("recognises analytics, payment, auth and CDN hosts", () => {
    const result = analyze(
      [
        'a("https://www.google-analytics.com/collect");',
        'b("https://js.stripe.com/v3");',
        'c("https://tenant.auth0.com/authorize");',
        'd("https://cdn.jsdelivr.net/npm/x");',
      ].join("\n"),
    );
    const byOrigin = new Map(result.origins.map((o) => [o.origin, o.kind]));
    expect(byOrigin.get("https://www.google-analytics.com")).toBe("analytics");
    expect(byOrigin.get("https://js.stripe.com")).toBe("payment");
    expect(byOrigin.get("https://tenant.auth0.com")).toBe("auth");
    expect(byOrigin.get("https://cdn.jsdelivr.net")).toBe("cdn");
  });

  it("calls a sibling subdomain same-site, not third-party", () => {
    // §10A.4's list mixes whose an origin is with what it does, and
    // `api.shop.example.com` is honestly both. Relationship wins, because
    // whether an origin is inside the target is what decides whether the
    // scan may visit it — and calling the application's own API host `api`
    // without saying it is ours reads as an external dependency.
    const result = analyze('fetch("https://api.shop.example.com/v1/orders");');
    expect(result.origins[0]?.kind).toBe("same_site");
    // The service hint is not lost, only demoted.
    expect(result.origins[0]?.basis).toContain("API");
  });

  it("keeps the service label for a host that is nobody's relation", () => {
    // There the service is the whole of what is worth saying.
    const result = analyze('a("https://api.unrelated-vendor.com/v1");');
    expect(result.origins[0]?.kind).toBe("api");
  });

  it("states the basis for every classification", () => {
    const result = analyze('fetch("https://unknown.example.net/x");');
    expect(result.origins[0]?.basis.length).toBeGreaterThan(10);
  });

  it("says unknown rather than guessing when there is no page origin", () => {
    const result = analyzer.analyze({
      script: "app.js",
      source: 'fetch("https://somewhere.example.net/x");',
    });
    expect(result.origins[0]?.kind).toBe("unknown");
  });

  it("recognises a websocket origin by its scheme", () => {
    const result = analyze('new WebSocket("wss://live.example.com/feed");');
    expect(result.origins[0]?.kind).toBe("websocket");
  });
});

describe("telling endpoints from routes from assets", () => {
  it("files an API-prefixed path as an API", () => {
    for (const path of ["/api/x", "/v2/orders", "/graphql", "/rest/items", "/rpc/call"]) {
      const result = analyze(`const p = "${path}";`);
      expect(
        result.apis.map((a) => a.path),
        path,
      ).toContain(path);
    }
  });

  it("files a plain path as a client route", () => {
    const result = analyze('const p = "/checkout/confirm";');
    expect(result.routes.map((r) => r.path)).toContain("/checkout/confirm");
    expect(result.apis).toHaveLength(0);
  });

  it("files neither for a static asset", () => {
    for (const path of ["/static/app.js", "/img/logo.png", "/fonts/x.woff2", "/app.css"]) {
      const result = analyze(`const p = "${path}";`);
      expect(result.apis, path).toHaveLength(0);
      expect(result.routes, path).toHaveLength(0);
    }
  });

  it("ignores strings that are not paths at all", () => {
    const result = analyze('const a = "hello world"; const b = "AAPL"; const c = "1.2.3";');
    expect(result.urls).toHaveLength(0);
  });
});

describe("configuration (§10A.2 item 8)", () => {
  it("captures an API base held in a named constant", () => {
    const result = analyze('const API_BASE_URL = "https://api.example.com/v2";');
    expect(result.config[0]).toMatchObject({
      key: "API_BASE_URL",
      value: "https://api.example.com/v2",
    });
  });

  it("captures a base URL in an options object", () => {
    const result = analyze('const client = axios.create({ baseURL: "/api/v1" });');
    expect(result.config.map((c) => c.key)).toContain("baseURL");
  });

  it("keeps the expression when the value is not a literal", () => {
    const result = analyze("const apiUrl = process.env.API_URL;");
    expect(result.config[0]?.value).toBeUndefined();
    expect(result.config[0]?.expression).toContain("process.env");
  });

  it("does not treat an unrelated constant as configuration", () => {
    const result = analyze('const TITLE = "Shop"; const retries = 3;');
    expect(result.config).toHaveLength(0);
  });
});

describe("§10B.9: a parser failure is an event, not a scan failure", () => {
  it("returns what it found from a truncated bundle", () => {
    // The row that decided the parser. §41's body limits mean a large bundle
    // may be captured only in part, and a parser that throws on truncated
    // input extracts nothing from it.
    const result = analyze('fetch("/api/orders");\nfetch("/api/cart", { method: "PO');
    expect(result.status).toBe("partial");
    expect(result.apis.map((a) => a.path)).toContain("/api/orders");
    expect(result.limitReason).toBeTruthy();
  });

  it("returns what it found from unbuilt TypeScript", () => {
    const result = analyze('const x: string = "/api/typed"; fetch("/api/orders");');
    expect(result.apis.map((a) => a.path)).toContain("/api/orders");
    expect(["partial", "complete"]).toContain(result.status);
  });

  it("never throws, whatever it is given", () => {
    for (const source of ["", "{{{{{", "\\uD800", "</script>", "0".repeat(10_000)]) {
      expect(() => analyze(source), JSON.stringify(source.slice(0, 20))).not.toThrow();
    }
  });

  it("stops at its time budget and says so", () => {
    const huge = 'fetch("/api/x");'.repeat(80_000);
    const result = analyzer.analyze({ script: "big.js", source: huge, timeBudgetMs: 1 });
    expect(result.status).toBe("partial");
    expect(result.limitReason).toContain("budget");
  });
});

describe("determinism", () => {
  it("produces identical findings from identical input", () => {
    // Everything except `durationMs`, which is a measurement rather than a
    // finding. It is the one field here that must never reach a diffable
    // artifact — the M1 gate masks the scan duration for the same reason.
    const source = [
      'fetch("/api/b");',
      'fetch("/api/a");',
      'const API_URL = "https://api.example.com";',
      'router.push("/z");',
      'router.push("/a");',
    ].join("\n");

    const findings = (input: string) => {
      const { durationMs: _measured, ...rest } = analyze(input);
      return JSON.stringify(rest);
    };
    expect(findings(source)).toBe(findings(source));
  });

  it("keeps the measurement out of the findings", () => {
    // Stated as a test so a later change that folds timing into a candidate
    // has to argue with something.
    const { durationMs: _measured, ...rest } = analyze('fetch("/api/x");');
    expect(JSON.stringify(rest)).not.toMatch(/\bdurationMs\b|\belapsed\b/);
  });

  it("sorts candidates, so a report diffs cleanly", () => {
    const result = analyze('fetch("/api/z");\nfetch("/api/a");\nfetch("/api/m");');
    expect(result.apis.map((a) => a.path)).toEqual(["/api/a", "/api/m", "/api/z"]);
  });
});
