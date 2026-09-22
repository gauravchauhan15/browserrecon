/**
 * Fixture: requests that are concurrent, and requests that are not —
 * build plan §15, §35B.4; dev plan BR-M2-18.
 *
 * The M2 gate needs a target where the wrong answer is visible. §15's worst
 * failure is presenting concurrency as a dependency chain: a reader told
 * that `GET /api/user` depends on `GET /api/cart` will try to exploit an
 * ordering that was never required, and nothing in the report tells them it
 * was invented.
 *
 * So this page does both, deliberately and separately:
 *
 *   `/parallel`  fires four requests in one `Promise.all`. No ordering
 *                exists between them and any dependency edge is false.
 *
 *   `/chain`     a genuine chain. `POST /api/orders` returns an id, and the
 *                next request cannot be built without it. A model that finds
 *                no edge here has the opposite failure — it can tell you
 *                nothing about what depends on what.
 *
 * Both are needed. A fixture with only the first rewards a tool that never
 * infers anything; one with only the second rewards a tool that infers
 * everything.
 *
 * ## The ids are fixed
 *
 * `POST /api/orders` always returns the same order id. Determinism is the
 * point (§36.2), and a generated id would make every golden comparison
 * differ while testing nothing extra — the flow is the same whether the id
 * is random or not.
 */
import type { FixtureApp, FixtureResponse, FixtureState } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** Fixed so a golden baseline can contain it. */
export const ORDER_ID = "8f14e45fceea167a5a36dedd4bea2543";
/** The four calls `/parallel` issues together. */
export const PARALLEL_PATHS = [
  "/api/cart",
  "/api/user",
  "/api/config",
  "/api/notifications",
] as const;

interface Calls extends FixtureState {
  /** Arrival order, so a test can assert what actually overlapped. */
  order: string[];
}

function json(body: unknown, status = 200): FixtureResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function parallelPage(): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en"><head><title>Parallel</title></head><body>',
      "<h1>Parallel</h1>",
      '<a href="/chain">Chain</a>',
      "<script>",
      // One Promise.all: the browser issues all four before any response
      // comes back, which is exactly the shape that must not become a chain.
      `  Promise.all(${JSON.stringify([...PARALLEL_PATHS])}.map((p) => fetch(p)));`,
      "</script>",
      "</body></html>",
    ].join("\n"),
  };
}

function chainPage(): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en"><head><title>Chain</title></head><body>',
      "<h1>Chain</h1>",
      '<button id="order">Place order</button>',
      "<script>",
      "  document.getElementById('order').addEventListener('click', async () => {",
      // Each step needs the previous one's answer. The id in the response is
      // the only way to build the next URL, which is what makes the
      // dependency structural rather than temporal.
      "    const created = await (await fetch('/api/orders', { method: 'POST' })).json();",
      "    const order = await (await fetch('/api/orders/' + created.order_id)).json();",
      "    await fetch('/api/orders/' + order.order_id + '/receipt');",
      "  });",
      "</script>",
      "</body></html>",
    ].join("\n"),
  };
}

export function parallelSite(): FixtureApp {
  const record =
    (name: string, response: FixtureResponse) =>
    (_request: unknown, state: FixtureState): FixtureResponse => {
      (state as Calls).order.push(name);
      return response;
    };

  return {
    name: "parallel-site",
    seedState: (): Calls => ({ order: [] }),
    routes: [
      { method: "GET", path: "/", handler: parallelPage },
      { method: "GET", path: "/chain", handler: chainPage },

      { method: "GET", path: "/api/cart", handler: record("cart", json({ items: 0 })) },
      { method: "GET", path: "/api/user", handler: record("user", json({ signedIn: false })) },
      {
        method: "GET",
        path: "/api/config",
        handler: record("config", json({ currency: "GBP" })),
      },
      {
        method: "GET",
        path: "/api/notifications",
        handler: record("notifications", json({ unread: 0 })),
      },

      // The chain. Each response carries the id the next request needs.
      {
        method: "POST",
        path: "/api/orders",
        handler: record("orders.create", json({ order_id: ORDER_ID, status: "created" }, 201)),
      },
      {
        method: "GET",
        path: "/api/orders/:id",
        handler: (request, state) => {
          (state as Calls).order.push("orders.read");
          return json({ order_id: request.params.id ?? "", status: "created" });
        },
      },
      {
        method: "GET",
        path: "/api/orders/:id/receipt",
        handler: (request, state) => {
          (state as Calls).order.push("orders.receipt");
          return json({ order_id: request.params.id ?? "", total: 1250 });
        },
      },
    ],
  };
}
