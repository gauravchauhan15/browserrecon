/**
 * Fixture: a WebMCP registry shaped the way a production one actually is.
 *
 * Build plan §21; found during Gate A preparation.
 *
 * `webmcp-site.ts` models the shape I guessed at when the spec was young: a
 * plain array of descriptors on `navigator.modelContext`. The first real site
 * this tool was pointed at disagreed on four points at once, and the scan
 * reported zero tools while four sat in the page:
 *
 *  - `tools` is a **`Map`**, keyed by tool name. `Array.isArray` is false,
 *    and the adapter skipped the registry without a word.
 *  - Each value is a **wrapper**, not the descriptor — the public tool lives
 *    under `item`, beside internals like `execute` and `mcpHandle`.
 *  - The wrapper also carries `registeredInputSchema`, the **JSON text** of
 *    the schema, while `item.inputSchema` is the object form.
 *  - Descriptors carry **`annotations`** — `readOnlyHint`,
 *    `untrustedContentHint` and friends — which nothing was reading.
 *
 * This fixture reproduces all four. Both it and the array-shaped one are
 * scanned by the tests, because an adapter that handles only the newer shape
 * has made the same mistake in the other direction.
 */
import type { FixtureApp, FixtureResponse, FixtureState } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/**
 * What the page registers. Exported so a test asserts against one list.
 *
 * `cancel-order` is deliberately not read-only. §7.2: an exposed destructive
 * operation is something to *report*, never something to try, and a registry
 * of uniformly safe tools would let a scan claim it "handled annotations"
 * without ever facing the case that matters.
 */
export const WEBMCP_MAP_TOOLS = [
  {
    name: "search-products",
    description: "Search the product catalog by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    name: "get-cart",
    description: "Return the contents of the current cart.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "cancel-order",
    description: "Cancel an order that has not yet shipped.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  // `readOnlyHint: false` with no destructive hint. MCP means "may modify
  // its environment", which covers a navigation helper — observed on the
  // reference application. Reporting this identically to
  // `cancel-order` is the false alarm that teaches a reader to discount the
  // real ones, so the two are kept apart and this fixture proves it.
  {
    name: "navigate-to-city",
    description: "Move the page to a city listing.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    annotations: { readOnlyHint: false },
  },
  // No annotations at all — observed on a second WebMCP site, where every tool
  // omits them. Must read as "unstated", never as "read-only".
  {
    name: "list-guides",
    description: "List published buying guides.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

function shell(): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en"><head><title>Map-shaped WebMCP</title></head><body>',
      "<h1>Shop</h1>",
      "<script>",
      // Registered **late**, which is the other thing production does.
      //
      // Every registry in this file used to appear in the first tick of the
      // first inline script, so a harvest timed from `domcontentloaded`
      // always won the race and the tests could not tell a scanner that
      // waits from one that does not. The reference application defines
      // `navigator.modelContext` roughly nine seconds after navigation — a
      // polyfill, loaded as its own script — and registers its five tools
      // later again. The scan read the page long before any of it and
      // reported none.
      //
      // So the registry itself arrives on a timer, and the tools after it.
      // Short enough to keep the suite quick, late enough that a harvest
      // which does not wait reads an empty page and an adapter that waits
      // only for the registry object reads an empty registry.
      "setTimeout(function () {",
      // A registry shaped like the production one: a Map of wrappers, with
      // the descriptor under `item` and the schema also present as text.
      "  navigator.modelContext = navigator.modelContext || {",
      "    __isBrowserMcpServer: true,",
      "    tools: new Map(),",
      "    registrations: new Set(),",
      "  };",
      // Two shapes in one registry, because three real sites disagreed: a
      // router's admin UI wraps the descriptor under `item` with the schema
      // also as text; the other two store it flat with an `outputSchema`
      // beside it. An adapter that handles one and not the other is broken
      // against half the web, so both are registered here and the gate
      // asserts every tool is found.
      "  let wrapNext = true;",
      "  navigator.modelContext.registerTool = function (descriptor) {",
      "    const wrapped = wrapNext;",
      "    wrapNext = !wrapNext;",
      "    this.tools.set(",
      "      descriptor.name,",
      "      wrapped",
      "        ? {",
      "            item: descriptor,",
      "            registeredInputSchema: JSON.stringify(descriptor.inputSchema),",
      "            execute: async () => ({ ok: true }),",
      "            mcpHandle: {},",
      "          }",
      "        : {",
      "            ...descriptor,",
      "            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },",
      "            execute: async () => ({ ok: true }),",
      "          },",
      "    );",
      "  };",
      "  navigator.modelContext.getTools = function () { return this.tools; };",
      // In two batches with a gap, because that is how it happens. In the
      // reference application the registry existed and held nothing for 7.9
      // seconds,
      // then two tools appeared, then the other three 2.8 seconds later. A
      // wait that stops as soon as the count pauses harvested two of the
      // five and said nothing about the rest; one batch here could not have
      // caught that.
      `  const tools = ${JSON.stringify(WEBMCP_MAP_TOOLS)};`,
      "  setTimeout(function () {",
      "    for (const tool of tools.slice(0, 2)) navigator.modelContext.registerTool(tool);",
      "    setTimeout(function () {",
      "      for (const tool of tools.slice(2)) navigator.modelContext.registerTool(tool);",
      "    }, 800);",
      "  }, 600);",
      "}, 900);",
      "</script>",
      "</body></html>",
    ].join("\n"),
  };
}

interface Calls extends FixtureState {
  /** Endpoints that were reached, so a test can assert none were. */
  reached: string[];
}

export function webmcpMapSite(): FixtureApp {
  return {
    name: "webmcp-map-site",
    seedState: (): Calls => ({ reached: [] }),
    routes: [
      { method: "GET", path: "/", handler: shell },
      {
        method: "GET",
        path: "/api/products/search",
        handler: (_request, state) => {
          (state as Calls).reached.push("/api/products/search");
          return { status: 200, headers: JSON_HEADERS, body: '{"results":[]}' };
        },
      },
      // Reachable, and never to be called by a scan. Its presence is what
      // makes "reported, not invoked" an assertion rather than a claim.
      {
        method: "POST",
        path: "/api/orders/cancel",
        handler: (_request, state) => {
          (state as Calls).reached.push("/api/orders/cancel");
          return { status: 200, headers: JSON_HEADERS, body: '{"cancelled":true}' };
        },
      },
    ],
  };
}
