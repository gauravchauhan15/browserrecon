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
  // its environment", which covers a navigation helper — observed on
  // feverup.com as `home_navigate_to_city`. Reporting this identically to
  // `cancel-order` is the false alarm that teaches a reader to discount the
  // real ones, so the two are kept apart and this fixture proves it.
  {
    name: "navigate-to-city",
    description: "Move the page to a city listing.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    annotations: { readOnlyHint: false },
  },
  // No annotations at all — observed on pickcrest.com, where every tool
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
      // A registry shaped like the production one: a Map of wrappers, with
      // the descriptor under `item` and the schema also present as text.
      "  navigator.modelContext = navigator.modelContext || {",
      "    __isBrowserMcpServer: true,",
      "    tools: new Map(),",
      "    registrations: new Set(),",
      "  };",
      // Two shapes in one registry, because three real sites disagreed:
      // NETGEAR wraps the descriptor under `item` with the schema also as
      // text; feverup and pickcrest store it flat with an `outputSchema`
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
      `  for (const tool of ${JSON.stringify(WEBMCP_MAP_TOOLS)}) {`,
      "    navigator.modelContext.registerTool(tool);",
      "  }",
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
