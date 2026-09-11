/**
 * Fixture: a static multi-page site — build plan §36.1, dev plan BR-M0-13.
 *
 * The baseline target for the Deterministic Explorer (§5A). It is deliberately
 * boring HTML, but every page here exists to exercise one discovery mechanism
 * the explorer is supposed to have:
 *
 *   `/`                 DOM link extraction, and a relative-link mix
 *   `/products`         a listing that links to route-template instances
 *   `/products/:id`     three instances of one template, for the saturation
 *                       logic in §9.5.3 to collapse
 *   `/products/9`       an instance that *diverges* from its siblings, which
 *                       §9.5.3 requires to block saturation
 *   `/contact`          a form, so form discovery has something to find
 *   `/app.js`           endpoint strings only reachable by JS mining (§10A)
 *   `/robots.txt`       a discovery source and a rate floor (§8.3)
 *   `/sitemap.xml`      a discovery source listing a page nothing links to
 *   `/orphan`           that page — findable only via the sitemap
 *   `/gone`             a dead reference, linked from `/` but answering 410
 *   `/old-home`         a relative redirect, so redirect following is covered
 *
 * Nothing here reads a clock or a random number, so every response is the same
 * on every run. See harness.ts for why that matters and where it is easy to
 * get wrong.
 */
import type { FixtureApp, FixtureResponse } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;

function page(title: string, body: string): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      `<title>${title}</title>`,
      '<script src="/app.js"></script>',
      "</head>",
      "<body>",
      `<h1>${title}</h1>`,
      body,
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  };
}

/** The three sibling instances of `/products/:id`, plus the divergent one. */
const PRODUCTS: Readonly<Record<string, { name: string; price: string }>> = {
  "1": { name: "Blue widget", price: "9.99" },
  "2": { name: "Red widget", price: "12.50" },
  "3": { name: "Green widget", price: "11.00" },
};

export function staticSite(): FixtureApp {
  return {
    name: "static-site",
    routes: [
      {
        method: "GET",
        path: "/",
        handler: () =>
          page(
            "Widget Co",
            [
              "<nav>",
              '<a href="/about">About</a>',
              '<a href="/products">Products</a>',
              '<a href="/contact">Contact</a>',
              // A link that answers 410. §9.5's "dead references" case: the
              // explorer must record it as unreachable rather than retry it.
              '<a href="/gone">Discontinued</a>',
              // A redirect, to exercise following one.
              '<a href="/old-home">Old home</a>',
              "</nav>",
            ].join("\n"),
          ),
      },
      {
        method: "GET",
        path: "/about",
        handler: () => page("About", '<p>We make widgets.</p><a href="/">Home</a>'),
      },
      {
        method: "GET",
        path: "/products",
        handler: () =>
          page(
            "Products",
            [
              "<ul>",
              ...Object.entries(PRODUCTS).map(
                ([id, product]) => `<li><a href="/products/${id}">${product.name}</a></li>`,
              ),
              // Linked like its siblings but answers differently — see /products/9.
              '<li><a href="/products/9">Prototype widget</a></li>',
              "</ul>",
            ].join("\n"),
          ),
      },
      {
        method: "GET",
        path: "/products/9",
        handler: () =>
          // Structurally unlike its siblings: an extra form, and a different
          // shape. §9.5.3 treats divergence inside a route template as a
          // reason NOT to saturate, and as a signal in its own right — so one
          // instance has to actually diverge for that to be testable.
          page(
            "Prototype widget",
            [
              "<p>Internal prototype.</p>",
              '<form method="post" action="/admin/approve">',
              '<input type="hidden" name="product" value="9">',
              '<button type="submit">Approve</button>',
              "</form>",
            ].join("\n"),
          ),
      },
      {
        method: "GET",
        path: "/products/:id",
        handler: (request) => {
          const product = PRODUCTS[request.params.id ?? ""];
          if (product === undefined) {
            return {
              status: 404,
              headers: HTML,
              body: "<!doctype html>\n<p>No such product</p>\n",
            };
          }
          return page(
            product.name,
            `<p>Price: ${product.price}</p><a href="/products">Back</a>`,
          );
        },
      },
      {
        method: "GET",
        path: "/contact",
        handler: () =>
          page(
            "Contact",
            [
              '<form method="post" action="/contact">',
              '<input name="email" type="email">',
              '<textarea name="message"></textarea>',
              '<button type="submit">Send</button>',
              "</form>",
            ].join("\n"),
          ),
      },
      {
        method: "POST",
        path: "/contact",
        handler: () => page("Thanks", "<p>Message received.</p>"),
      },
      {
        method: "GET",
        path: "/orphan",
        // Reachable only through sitemap.xml. Proves the sitemap is actually
        // being read rather than the crawler getting there some other way.
        handler: () => page("Orphan", "<p>Nothing links here.</p>"),
      },
      {
        method: "GET",
        path: "/gone",
        handler: () => ({
          status: 410,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: "gone\n",
        }),
      },
      {
        method: "GET",
        path: "/old-home",
        handler: () => ({
          status: 301,
          // Relative, not absolute. An absolute URL would have to contain the
          // ephemeral port, which changes every run — see harness.ts.
          headers: { location: "/" },
        }),
      },
      {
        method: "GET",
        path: "/app.js",
        handler: () => ({
          status: 200,
          headers: { "content-type": "text/javascript; charset=utf-8" },
          // Three endpoints that appear nowhere in the HTML, findable only by
          // parsing this file — what the JS mining stage (§10A) is for.
          //
          // Two are plain string literals, which a quoted-path regex finds.
          // The third, `/api/v1/cart`, is deliberately NOT written out: it
          // exists only as `API_BASE + "/cart"`, so finding it requires
          // resolving a concatenation rather than matching a pattern. That is
          // the case that separates a real extractor from a regex, and
          // apps.test.ts asserts the literal stays absent.
          body: [
            "// Widget Co front-end",
            'const API_BASE = "/api/v1";',
            "export async function loadCart() {",
            '  return fetch(API_BASE + "/cart").then((r) => r.json());',
            "}",
            "export async function trackEvent(name) {",
            '  return fetch("/api/v1/telemetry", { method: "POST", body: name });',
            "}",
            'const ADMIN_ENDPOINT = "/api/v1/admin/users";',
            "",
          ].join("\n"),
        }),
      },
      {
        method: "GET",
        path: "/robots.txt",
        handler: () => ({
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: [
            "User-agent: *",
            "Crawl-delay: 1",
            "Disallow: /admin",
            "Sitemap: /sitemap.xml",
            "",
          ].join("\n"),
        }),
      },
      {
        method: "GET",
        path: "/sitemap.xml",
        handler: () => ({
          status: 200,
          headers: { "content-type": "application/xml; charset=utf-8" },
          body: [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            // Relative locations, for the same reason redirects are relative.
            // Real sitemaps use absolute URLs; a fixture cannot, because the
            // port is not known until the server is listening.
            ...["/", "/about", "/products", "/orphan"].map(
              (path) => `  <url><loc>${path}</loc></url>`,
            ),
            "</urlset>",
            "",
          ].join("\n"),
        }),
      },
    ],
  };
}
