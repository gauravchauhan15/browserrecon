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

describe("a minified bundle names its endpoints in template literals", () => {
  /**
   * The case the M3 gate's first real target exposed.
   *
   * 110 first-party Angular bundles, every body captured, zero API
   * candidates. The call-site rules need a callee that reads like a request
   * — `fetch`, or a verb on something named `api`/`http`/`client` — and a
   * bundler renames the wrapper to `r`. So the only surviving signal is the
   * literal itself, and `literalOf` returned nothing for a template with an
   * interpolation: correct for a *value*, and silently applied to candidate
   * extraction too.
   */
  const minified = `class r{constructor(e){this.h=e}
    a(e){return this.h.get(\`/api/v2/orders/\${e}\`)}
    b(){return this.h.post("/api/v2/cart",{})}
    c(e){return this.h.get(\`/\${e.slugLanguage}/\${e.slug}\`)}
    d(e){return this.h.get(\`/api/v2/users/\${e.id}/profile\`)}}`;

  it("finds a templated endpoint no call-site rule could reach", () => {
    const paths = analyze(minified).apis.map((candidate) => candidate.path);
    expect(paths).toContain("/api/v2/orders/{e}");
    expect(paths).toContain("/api/v2/users/{param}/profile");
  });

  it("still finds the plain literal beside it", () => {
    expect(analyze(minified).apis.map((c) => c.path)).toContain("/api/v2/cart");
  });

  it("does not take a path of nothing but placeholders for an endpoint", () => {
    // `/{slugLanguage}/{slug}` is how a site writes every content URL.
    // Admitting it puts a city page at the top of an API inventory, and the
    // rule that finds the templated endpoints above would otherwise do
    // exactly that.
    const result = analyze(minified);
    expect(result.apis.map((c) => c.path)).not.toContain("/{param}/{param}");
    expect(result.routes.map((c) => c.path)).toContain("/{param}/{param}");
  });

  it("keeps the shape without inventing the value", () => {
    // §10A.5. `{e}` is the hole the developer left, not a guess at what
    // goes in it, and nothing in the output claims to know.
    const candidate = analyze(minified).apis.find((c) => c.path.startsWith("/api/v2/orders"));
    // The parameter segment is a hole, not a sample value.
    expect(candidate?.path.split("/").pop()).toBe("{e}");
  });

  it("admits a placeholder-only path in a request position", () => {
    // The exception the guard above is written around: at a call site the
    // position is the evidence, so the shape does not have to carry it.
    const paths = analyze("fetch(`/${a}/${b}`)").apis.map((c) => c.path);
    expect(paths).toContain("/{a}/{b}");
  });
});

describe("a bundle lists its endpoints together", () => {
  /**
   * Taken from a production bundle's HTTP interceptor: the paths it attaches
   * a header to. Most of them carry no marker at all, and read one at a time
   * they are pages.
   */
  const interceptor = `
    function matches(t){
      return [\`/custom_main_plans_for_user/\`,\`/onboarding/questions/main_plans_to_rate/\`,
        \`/onboarding/answers/\`,\`/you-may-also-like/\`,\`/category/calendar_view/\`,
        \`/category/skeleton/\`,\`/category/plan_grid/\`,\`/v2/plan/\`,\`/v1/plan_india/\`,
        \`/v3/plan/\`,\`/v1/city/\`,\`/v1/city_india/\`,\`/search-api/v2/plan/\`].some(i=>t.includes(i))
    }`;

  it("promotes the whole table once one entry is plainly an API", () => {
    const paths = analyze(interceptor).apis.map((candidate) => candidate.path);
    for (const expected of [
      "/custom_main_plans_for_user/",
      "/onboarding/questions/main_plans_to_rate/",
      "/you-may-also-like/",
      "/category/skeleton/",
      "/v2/plan/",
      "/search-api/v2/plan/",
    ]) {
      expect(paths, `${expected} was not found`).toContain(expected);
    }
  });

  it("says the array is what promoted them", () => {
    // The evidence is the company the string keeps, and a reader has to be
    // able to disagree with that.
    const promoted = analyze(interceptor).apis.find(
      (candidate) => candidate.path === "/category/skeleton/",
    );
    expect(promoted?.basis).toMatch(/array/i);
    expect(promoted?.confidence).toBe("low");
  });

  it("does not report one path as both a screen and an endpoint", () => {
    const result = analyze(interceptor);
    const apis = new Set(result.apis.map((candidate) => candidate.path));
    for (const route of result.routes) {
      expect(apis.has(route.path), `${route.path} is in both lists`).toBe(false);
    }
  });

  it("leaves an array of plain routes alone", () => {
    // The control. Without an entry that is an API on its own evidence, a
    // route table is a route table — and promoting one would put every
    // screen in the application in the API inventory.
    const routes = `const r=[\`/about\`,\`/contact\`,\`/pricing\`,\`/careers\`];`;
    expect(analyze(routes).apis).toEqual([]);
  });

  it("needs more than one path before an array is a table", () => {
    // Found by probe: an array holding a single *route* is already rejected
    // for having no API sibling, so that case proved nothing. What the
    // minimum actually protects is the basis. A lone API path in an array
    // is an API on its own evidence, and reporting it as "listed alongside
    // API paths" describes siblings it does not have.
    const lone = `const r=[\`/v2/plan/\`];`;
    const candidate = analyze(lone).apis.find((entry) => entry.path === "/v2/plan/");
    expect(candidate).toBeDefined();
    expect(candidate?.basis).toBe("path is under an API prefix");
  });

  it("does not promote an array of assets", () => {
    const assets = `const a=[\`/v1/app.js\`,\`/static/logo.png\`,\`/static/main.css\`];`;
    expect(analyze(assets).apis).toEqual([]);
  });
});

describe("an API marker need not be the first segment", () => {
  it("finds an endpoint routed under its own service", () => {
    // `/search-api/v2/plan/` is a real endpoint on a real site, and
    // anchoring the marker to the start of the path called it a page.
    const paths = analyze('fetch2("/search-api/v2/plan/")').apis.map((c) => c.path);
    expect(paths).toContain("/search-api/v2/plan/");
  });

  it("wants the marker to be a word, not a substring", () => {
    // `/capital/` contains "api". A bare substring test puts every page
    // whose name happens to contain three letters in the API inventory.
    const result = analyze('const r=["/capital/cities/","/rapid/transit/"];');
    expect(result.apis).toEqual([]);
  });
});

describe("endpoints written as a path hanging off an API base", () => {
  /**
   * The dominant shape in the application this was measured against: the
   * author says in the string itself that what follows hangs off the API
   * base, so nothing has to be inferred and no variable followed.
   */
  it("reads the path and the version out of the template", () => {
    const source = "const x=`${this.r.getApiBaseUrl(`4.1`)}loyalty/status/`;";
    const candidate = analyze(source).apis[0];
    expect(candidate?.path).toBe("/4.1/loyalty/status/");
    expect(candidate?.basis).toBe('relative to getApiBaseUrl("4.1")');
  });

  it("reduces the rest of the template's holes as usual", () => {
    const source =
      "const l=`${this.n.getApiBaseUrl(`5.0`)}login/${this.t.user.id}/account-email/`;";
    // `{param}`, not `{id}`: `this.t.user.id` is an expression, and naming a
    // hole after the last word of one is a guess dressed as a parameter name.
    expect(analyze(source).apis.map((c) => c.path)).toContain(
      "/5.0/login/{param}/account-email/",
    );
  });

  it("works for a base getter that names its own service", () => {
    const source = "const x=`${e.getFavoritesApiBaseUrl()}plans/saved/`;";
    expect(analyze(source).apis[0]?.path).toBe("/plans/saved/");
  });

  it("does not invent the origin the base resolves to", () => {
    // §10A.5. The host is a runtime value; a fabricated one in an endpoint
    // inventory sends somebody looking for a URL that never existed.
    const source = "const x=`${e.getApiBaseUrl(`4.1`)}loyalty/status/`;";
    expect(analyze(source).apis[0]?.path).not.toMatch(/https?:/);
  });

  it("ignores a template that merely contains a base somewhere", () => {
    // `/assets/${base}/x` is a path with something interpolated into it, not
    // a path hanging off a base, and treating the two alike would reorder
    // the string into something the code never builds.
    const source = "const x=`/assets/${e.getApiBaseUrl()}/thing`;";
    expect(analyze(source).apis.map((c) => c.basis)).not.toContain(
      "relative to getApiBaseUrl()",
    );
  });

  it("ignores a base followed by nothing but a hole", () => {
    // `${base}${path}` names no endpoint: the base is known and the rest is
    // a variable, so the row would tell a reader nothing.
    const source = "const x=`${e.getSearchApiBaseUrl()}${l}`;";
    expect(analyze(source).apis).toEqual([]);
  });

  it("ignores a getter whose name says nothing about an API base", () => {
    const source = "const x=`${e.getLocale()}loyalty/status/`;";
    expect(analyze(source).apis).toEqual([]);
  });
});

describe("an endpoint table written as regex matchers", () => {
  /** Taken from the same bundle: the paths an interceptor matches against. */
  const table =
    "function f(e,r){" +
    "let t=[`plans/trending/[a-zA-Z]+/filters/`,`plans/best/[a-zA-Z]+/`]," +
    "o=[`login/email/otp/`,`plans/.+/what/`,`vouchers/cart/.+/apply/`,`orders/.+/`]," +
    "n=[`vouchers/?$`,`payment(?!/payment-gateways-per-method)`,`orders/[0-9]+/tax-documents/`];" +
    "return[...t.map(i=>new RegExp(e.getApiBaseUrl()+i))," +
    "...o.map(i=>new RegExp(e.getApiBaseUrl(`4.2`)+i))," +
    "...n.map(i=>new RegExp(e.getApiBaseUrl(`4.3`)+i))]}";

  it("links each array to the base it is concatenated with", () => {
    const paths = analyze(table).apis.map((c) => c.path);
    expect(paths).toContain("/4.2/login/email/otp/");
    expect(paths).toContain("/4.3/orders/{param}/tax-documents/");
    expect(paths).toContain("/plans/best/{param}/");
  });

  it("reduces a matcher to the shape it matches", () => {
    // Same job `templatePath` does for `${}`: every variable part becomes a
    // hole, and nothing is invented to fill it.
    const paths = analyze(table).apis.map((c) => c.path);
    expect(paths).toContain("/4.2/vouchers/cart/{param}/apply/");
    expect(paths).toContain("/4.2/orders/{param}/");
  });

  it("treats a lookahead as an exclusion, not a segment", () => {
    // `payment(?!/payment-gateways-per-method)` matches `payment`. Reducing
    // the assertion to a hole invented `payment{param}`.
    expect(analyze(table).apis.map((c) => c.path)).toContain("/4.3/payment");
  });

  it("keeps an endpoint whose trailing slash is optional", () => {
    expect(analyze(table).apis.map((c) => c.path)).toContain("/4.3/vouchers/");
  });

  it("will not admit a relative path without a base to hang it on", () => {
    // The guard the whole rule rests on. Without a base, "a string with a
    // slash in it" is `text/html`, `utf-8` and half the noise in a bundle.
    const noBase = "const t=[`login/email/otp/`,`orders/.+/`,`vouchers/cart/.+/apply/`];";
    expect(analyze(noBase).apis).toEqual([]);
  });

  it("will not reduce a pattern it cannot fully resolve", () => {
    // Better to miss an endpoint than to print a mangled one: a half-reduced
    // pattern is a row that sends somebody looking for a URL that is not
    // there.
    const awkward =
      "function f(e){let t=[`a|b/c`,`orders/[0-9]+/`];return t.map(i=>new RegExp(e.getApiBaseUrl()+i))}";
    expect(analyze(awkward).apis.map((c) => c.path)).toEqual(["/orders/{param}/"]);
  });
});
