/**
 * Fixture: a page that publishes tools to agents — build plan §21;
 * dev plan BR-M1-30, BR-M1-24.
 *
 * A WebMCP page hands any visiting agent a list of named operations with
 * input schemas, usually wired straight to its own APIs. For recon that is
 * close to a free specification of the attack surface — and it is completely
 * invisible to anything watching network traffic, because registering a tool
 * is a JavaScript call that sends nothing.
 *
 * The spec is young and moving, so this fixture models the *shape* rather
 * than any one draft: a registry on `navigator`, tools with a name, a
 * description and a JSON input schema, and an invocation path. §21 keeps the
 * draft's details behind an adapter for exactly this reason, and the fixture
 * lives on the same side of that line.
 *
 * `deleteAccount` is here deliberately. A registry that only advertised safe
 * operations would let a scan claim it "found the tools" without ever facing
 * the question the tools raise: §7.2 says an exposed destructive operation is
 * something to *report*, never something to try.
 */
import type { FixtureApp, FixtureResponse, FixtureState } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** What the page registers. Exported so a test asserts against one list. */
export const WEBMCP_TOOLS = [
  {
    name: "searchProducts",
    description: "Search the catalog by keyword.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    endpoint: "/api/products/search",
    destructive: false,
  },
  {
    name: "addToCart",
    description: "Add a product to the current cart.",
    inputSchema: {
      type: "object",
      properties: { productId: { type: "string" }, quantity: { type: "integer" } },
      required: ["productId"],
    },
    endpoint: "/api/cart/items",
    destructive: false,
  },
  {
    name: "deleteAccount",
    description: "Permanently delete the signed-in account.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
    endpoint: "/api/account",
    destructive: true,
  },
] as const;

interface Calls extends FixtureState {
  /** Endpoints that were actually reached, so a test can assert none were. */
  reached: string[];
}

function shell(): FixtureResponse {
  const declared = WEBMCP_TOOLS.map(({ name, description, inputSchema, endpoint }) => ({
    name,
    description,
    inputSchema,
    endpoint,
  }));

  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en"><head><title>WebMCP shop</title></head><body>',
      "<h1>Shop</h1>",
      '<button id="invoke-search">Search via tool</button>',
      "<script>",
      // A registry shaped like the draft, without depending on its details.
      "  navigator.modelContext = navigator.modelContext || { tools: [] };",
      "  navigator.modelContext.registerTool = function (tool) {",
      "    this.tools.push(tool);",
      "    window.dispatchEvent(new CustomEvent('webmcp:registered', { detail: tool }));",
      "  };",
      `  for (const tool of ${JSON.stringify(declared)}) {`,
      "    navigator.modelContext.registerTool(tool);",
      "  }",
      "",
      // One invocation, driven by a click, so the collector can be tested on
      // the difference between a tool that exists and one that ran.
      "  document.getElementById('invoke-search').addEventListener('click', async () => {",
      "    const tool = navigator.modelContext.tools.find((t) => t.name === 'searchProducts');",
      "    await fetch(tool.endpoint + '?query=shoes');",
      "    window.dispatchEvent(new CustomEvent('webmcp:invoked', { detail: { name: tool.name, ok: true } }));",
      "  });",
      "</script>",
      "</body></html>",
    ].join("\n"),
  };
}

export function webmcpSite(): FixtureApp {
  const record =
    (endpoint: string, response: FixtureResponse) =>
    (_request: unknown, state: FixtureState): FixtureResponse => {
      (state as Calls).reached.push(endpoint);
      return response;
    };

  return {
    name: "webmcp-site",
    seedState: (): Calls => ({ reached: [] }),
    routes: [
      { method: "GET", path: "/", handler: shell },
      {
        method: "GET",
        path: "/api/products/search",
        handler: (request, state) => {
          (state as Calls).reached.push("/api/products/search");
          return {
            status: 200,
            headers: JSON_HEADERS,
            body: JSON.stringify({ query: request.query.query ?? "", results: [] }),
          };
        },
      },
      {
        method: "POST",
        path: "/api/cart/items",
        handler: record("/api/cart/items", {
          status: 201,
          headers: JSON_HEADERS,
          body: '{"added":true}',
        }),
      },
      // Reachable, and never to be called by a scan. Its presence is what
      // makes "reported, not invoked" an assertion rather than a claim.
      {
        method: "DELETE",
        path: "/api/account",
        handler: record("/api/account", {
          status: 200,
          headers: JSON_HEADERS,
          body: '{"deleted":true}',
        }),
      },
    ],
  };
}
