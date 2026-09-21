/**
 * Fixture: forms a scan may submit, and forms it may not — build plan §9.4,
 * §7.2; dev plan BR-M1-30.
 *
 * The deterministic explorer's whole job at a form is to decide *not* to
 * submit most of them. That decision is only testable against a page holding
 * both kinds side by side, in shapes that look similar enough to be confused:
 *
 *   `#search`    GET, idempotent, no side effect — safe to submit
 *   `#filter`    GET with several inputs, one a select — safe
 *   `#subscribe` POST that creates something — refused under the default policy
 *   `#delete`    POST that destroys something, with no confirmation step
 *   `#transfer`  POST that moves money, labelled as innocuously as possible
 *
 * `#transfer` earns its place by being *badly labelled*: the button says
 * "Continue" and the action is `/api/next`. A classifier that reads the
 * button text is fooled; one that reads the method and the named fields is
 * not. A fixture where every dangerous form announced itself would prove
 * nothing.
 */
import type { FixtureApp, FixtureResponse, FixtureState } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

interface Records extends FixtureState {
  /** Everything a request actually changed, so a test can assert nothing did. */
  mutations: string[];
}

function page(): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en"><head><title>Forms</title></head><body>',
      "<h1>Account</h1>",

      '<form id="search" method="get" action="/search">',
      '  <input type="search" name="q" placeholder="Search">',
      '  <button type="submit">Search</button>',
      "</form>",

      '<form id="filter" method="get" action="/products">',
      '  <input type="text" name="brand">',
      '  <select name="sort"><option value="price">Price</option><option value="name">Name</option></select>',
      '  <input type="checkbox" name="in_stock" value="1">',
      '  <button type="submit">Apply filters</button>',
      "</form>",

      '<form id="subscribe" method="post" action="/api/subscribe">',
      '  <input type="email" name="email">',
      '  <button type="submit">Subscribe</button>',
      "</form>",

      '<form id="delete" method="post" action="/api/account/delete">',
      '  <button type="submit">Delete my account</button>',
      "</form>",

      // Labelled to be misleading on purpose — see the file comment.
      '<form id="transfer" method="post" action="/api/next">',
      '  <input type="text" name="recipient_account">',
      '  <input type="number" name="amount_cents">',
      '  <button type="submit">Continue</button>',
      "</form>",

      "</body></html>",
    ].join("\n"),
  };
}

export function formsSite(): FixtureApp {
  const mutate =
    (what: string) =>
    (_request: unknown, state: FixtureState): FixtureResponse => {
      (state as Records).mutations.push(what);
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ done: what }) };
    };

  return {
    name: "forms-site",
    seedState: (): Records => ({ mutations: [] }),
    routes: [
      { method: "GET", path: "/", handler: page },
      {
        method: "GET",
        path: "/search",
        handler: (request) => ({
          status: 200,
          headers: HTML,
          body: `<!doctype html><html><body><h1>Results</h1><p>q=${request.query.q ?? ""}</p></body></html>`,
        }),
      },
      {
        method: "GET",
        path: "/products",
        handler: (request) => ({
          status: 200,
          headers: HTML,
          body: `<!doctype html><html><body><h1>Products</h1><p>sort=${request.query.sort ?? "none"}</p></body></html>`,
        }),
      },
      // Every one of these records what it did. A test asserting "the scan
      // submitted nothing destructive" reads this list rather than trusting
      // the scan's own account of itself.
      { method: "POST", path: "/api/subscribe", handler: mutate("subscribe") },
      { method: "POST", path: "/api/account/delete", handler: mutate("delete_account") },
      { method: "POST", path: "/api/next", handler: mutate("transfer") },
    ],
  };
}
