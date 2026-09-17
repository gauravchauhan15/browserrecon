/**
 * Fixture: a small REST API — build plan §36.1, dev plan BR-M0-13.
 *
 * Exercises the things a runtime recon tool has to get right about APIs:
 *
 *   GET  /api/v1/products        a collection
 *   GET  /api/v1/products/:id    a member, 404 for an unknown id
 *   GET  /api/v1/cart            state that a later POST changes
 *   POST /api/v1/cart/items      the mutation — an API *sequence*, not a page
 *   POST /api/v1/orders          depends on the cart being non-empty, so there
 *                                is a real dependency to discover (§15)
 *   GET  /api/v1/admin/users     401 — a role-gated endpoint (§9.5)
 *
 * ## Statefulness and determinism
 *
 * The cart mutates, which looks like it contradicts "byte-identical responses
 * across runs". It does not: determinism here means *the same request sequence
 * produces the same bytes*, and state is rebuilt from `seedState` for every
 * server instance. A fresh fixture always starts with an empty cart.
 *
 * What would break it is a handler closing over a module-level variable — then
 * the second test in a file inherits the first one's cart. That is why state
 * arrives as an argument.
 *
 * Order ids are derived from the cart's contents, not from a counter or a
 * clock, so the same sequence yields the same id.
 */
import type { FixtureApp, FixtureResponse, FixtureState } from "../types.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // A wide-open CORS policy, on purpose and for two reasons. It is what lets a
  // page on one origin call this API at all, which is how a real single-page
  // application is deployed — and a permissive `*` is itself attack surface a
  // recon tool ought to notice, so the fixture should present one to notice.
  "access-control-allow-origin": "*",
} as const;

/** Pretty-printed with a trailing newline, so a diff of two runs is readable. */
function json(status: number, value: unknown): FixtureResponse {
  return { status, headers: JSON_HEADERS, body: `${JSON.stringify(value, null, 2)}\n` };
}

interface Product {
  readonly id: string;
  readonly name: string;
  readonly price: number;
}

const PRODUCTS: readonly Product[] = [
  { id: "1", name: "Blue widget", price: 9.99 },
  { id: "2", name: "Red widget", price: 12.5 },
  { id: "3", name: "Green widget", price: 11.0 },
];

interface CartItem {
  readonly productId: string;
  readonly quantity: number;
}

interface ApiState extends FixtureState {
  cart: CartItem[];
  orders: string[];
}

function stateOf(state: FixtureState): ApiState {
  return state as ApiState;
}

export function restApi(): FixtureApp {
  return {
    name: "rest-api",
    seedState: (): FixtureState => ({ cart: [], orders: [] }),
    // A JSON API answering an HTML 404 page is a real-world annoyance and a
    // bad fixture: a client parsing the body would get a surprise that has
    // nothing to do with what is being tested.
    notFound: () => json(404, { error: "not_found" }),
    routes: [
      {
        method: "GET",
        path: "/api/v1/products",
        handler: () => json(200, { items: PRODUCTS, total: PRODUCTS.length }),
      },
      {
        method: "GET",
        path: "/api/v1/products/:id",
        handler: (request) => {
          const product = PRODUCTS.find((candidate) => candidate.id === request.params.id);
          return product === undefined
            ? json(404, { error: "no_such_product" })
            : json(200, product);
        },
      },
      {
        method: "GET",
        path: "/api/v1/cart",
        handler: (_request, state) => {
          const { cart } = stateOf(state);
          const total = cart.reduce((sum, item) => {
            const product = PRODUCTS.find((candidate) => candidate.id === item.productId);
            return sum + (product?.price ?? 0) * item.quantity;
          }, 0);
          // Rounded, or floating-point drift would make the body depend on the
          // order items were added in.
          return json(200, { items: cart, total: Math.round(total * 100) / 100 });
        },
      },
      {
        method: "POST",
        path: "/api/v1/cart/items",
        handler: (request, state) => {
          let payload: unknown;
          try {
            payload = JSON.parse(request.body === "" ? "{}" : request.body);
          } catch {
            return json(400, { error: "invalid_json" });
          }

          const { productId, quantity } = payload as {
            productId?: unknown;
            quantity?: unknown;
          };
          if (typeof productId !== "string") {
            return json(400, { error: "productId_required" });
          }
          if (!PRODUCTS.some((candidate) => candidate.id === productId)) {
            return json(404, { error: "no_such_product" });
          }

          const amount =
            typeof quantity === "number" && Number.isInteger(quantity) ? quantity : 1;
          stateOf(state).cart.push({ productId, quantity: amount });
          return json(201, { items: stateOf(state).cart });
        },
      },
      {
        method: "POST",
        path: "/api/v1/orders",
        handler: (_request, state) => {
          const api = stateOf(state);
          // The dependency worth discovering: this call cannot succeed until
          // the cart call has. §15 correlates that from observed traffic, so
          // the fixture has to actually enforce it.
          if (api.cart.length === 0) {
            return json(409, { error: "cart_empty" });
          }

          // Derived from the cart, not from a counter or a clock: the same
          // request sequence must produce the same order id every run.
          const id = `ord_${api.cart.map((item) => `${item.productId}x${item.quantity}`).join("_")}`;
          api.orders.push(id);
          api.cart = [];
          return json(201, { id, status: "placed" });
        },
      },
      {
        method: "GET",
        path: "/api/v1/admin/users",
        handler: () => ({
          status: 401,
          headers: { ...JSON_HEADERS, "www-authenticate": 'Bearer realm="widget-co"' },
          body: `${JSON.stringify({ error: "unauthorized" }, null, 2)}\n`,
        }),
      },
    ],
  };
}
