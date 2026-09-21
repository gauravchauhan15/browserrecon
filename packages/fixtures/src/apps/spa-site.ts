/**
 * Fixture: a single-page application — build plan §16; dev plan BR-M1-07.
 *
 * One document, many application URLs. This is the case a request-oriented
 * scan gets completely wrong: it sees one page load and concludes the
 * application has one page, while the user moved through four screens and the
 * app called three different APIs.
 *
 * Every route change the collector has to tell apart is reachable here, and
 * each one is driven by the page rather than by a timer, so the sequence is
 * identical on every run:
 *
 *   #/ then a link         `pushState` — a new history entry
 *   the "filter" button    `replaceState` — the same entry, rewritten
 *   the "anchor" link      a hash-only change
 *   back and forward       a traversal, which CDP mislabels as a fragment
 *
 * The buttons matter as much as the routes. §16.1 wants a navigation
 * attributed to the interaction that caused it, and that is only testable if
 * some route changes follow a click and others do not — `/auto` changes the
 * route with no interaction at all, which is the case attribution must decline
 * to claim.
 */
import type { FixtureApp, FixtureResponse } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;

/** The shell. Every application route is served by this one document. */
function shell(): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en">',
      "<head><title>SPA</title></head>",
      "<body>",
      "<h1>SPA</h1>",
      '<nav><a id="to-orders" href="#">Orders</a> <a id="to-anchor" href="#details">Details</a></nav>',
      '<button id="filter">Filter</button>',
      '<button id="auto">Start auto route</button>',
      '<div id="view">home</div>',
      "<script>",
      "  const view = document.getElementById('view');",
      "  function render(name) { view.textContent = name; }",
      "  document.getElementById('to-orders').addEventListener('click', (event) => {",
      "    event.preventDefault();",
      // A new history entry: the ordinary SPA route change.
      "    history.pushState({ view: 'orders' }, '', '/app/orders');",
      "    render('orders');",
      "    fetch('/api/orders');",
      "  });",
      "  document.getElementById('filter').addEventListener('click', () => {",
      // Same entry, rewritten — what a filter or sort control does, and what
      // must not be counted as a separate screen.
      "    history.replaceState({ view: 'orders', filter: 'open' }, '', '/app/orders?filter=open');",
      "    render('orders:open');",
      "  });",
      "  document.getElementById('auto').addEventListener('click', () => {",
      // Deliberately deferred past the click's own task, so the route change
      // is NOT attributable to it. Driven by the page, not a wall clock.
      "    queueMicrotask(() => { history.pushState({}, '', '/app/auto'); render('auto'); });",
      "  });",
      "  window.addEventListener('popstate', () => render('popped'));",
      "</script>",
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  };
}

export function spaSite(): FixtureApp {
  return {
    name: "spa-site",
    routes: [
      { method: "GET", path: "/", handler: shell },
      // The server answers every application route with the same shell, which
      // is how a real SPA is deployed and why a URL alone says nothing about
      // whether a document was loaded.
      { method: "GET", path: "/app/orders", handler: shell },
      { method: "GET", path: "/app/auto", handler: shell },
      {
        method: "GET",
        path: "/api/orders",
        handler: () => ({
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: '{ "orders": [] }\n',
        }),
      },
      {
        method: "GET",
        path: "/second",
        // A genuine document load, for contrast: the collector has to call
        // this one hard and the rest soft.
        handler: () => ({
          status: 200,
          headers: HTML,
          body: "<!doctype html>\n<html><head><title>Second</title></head><body>second</body></html>\n",
        }),
      },
    ],
  };
}
