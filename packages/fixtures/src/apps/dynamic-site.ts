/**
 * Fixture: a page that is not finished when it loads — build plan §5A, §19;
 * dev plan BR-M1-30.
 *
 * Three ways a modern page hides its surface from anything that reads the
 * initial HTML:
 *
 *   **Injected DOM.** The nav and half the links do not exist in the served
 *   markup; a script adds them. A crawler parsing HTML finds two links here
 *   and a browser finds six, which is most of why this tool uses a browser.
 *
 *   **Code-split chunks.** `/chunk-orders.js` is fetched only when a button
 *   is pressed, and it is where two endpoint strings live. JS discovery that
 *   reads only the entry bundle misses them, and so does anything that never
 *   presses the button.
 *
 *   **Deferred content.** "Load more" appends rows that were never in the
 *   document, each linking somewhere new — the shape that makes "did we
 *   reach the end of this page?" an open question rather than a parse.
 *
 * The chunk is served as a real module fetched by a real `import()`, not
 * simulated with a fetch, because the thing under test is whether the
 * telemetry sees a dynamically imported script at all.
 */
import type { FixtureApp, FixtureResponse } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JS = { "content-type": "text/javascript; charset=utf-8" } as const;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function shell(): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en"><head><title>Dynamic</title></head>',
      "<body>",
      "<h1>Dynamic</h1>",
      // The only two links in the served markup.
      '<a href="/about">About</a> <a href="/help">Help</a>',
      '<nav id="nav"></nav>',
      '<button id="load-orders">Orders</button>',
      '<button id="load-more">Load more</button>',
      '<ul id="rows"></ul>',
      '<script type="module" src="/app.js"></script>',
      "</body></html>",
    ].join("\n"),
  };
}

/** The entry bundle. Mentions no endpoint the chunk owns. */
function entryScript(): FixtureResponse {
  return {
    status: 200,
    headers: JS,
    body: [
      "const nav = document.getElementById('nav');",
      // Four links that exist only after this runs.
      "for (const [href, label] of [['/settings','Settings'],['/billing','Billing'],['/team','Team'],['/audit','Audit']]) {",
      "  const a = document.createElement('a');",
      "  a.href = href; a.textContent = label; a.id = 'nav-' + label.toLowerCase();",
      "  nav.append(a, ' ');",
      "}",
      "",
      "document.getElementById('load-orders').addEventListener('click', async () => {",
      // A genuine dynamic import, so the telemetry sees a script request it
      // could not have predicted from the entry bundle.
      "  const chunk = await import('/chunk-orders.js');",
      "  await chunk.load();",
      "});",
      "",
      "let page = 0;",
      "document.getElementById('load-more').addEventListener('click', async () => {",
      "  page += 1;",
      "  const response = await fetch('/api/rows?page=' + page);",
      "  const data = await response.json();",
      "  for (const row of data.rows) {",
      "    const li = document.createElement('li');",
      "    const a = document.createElement('a');",
      "    a.href = row.href; a.textContent = row.label;",
      "    li.append(a);",
      "    document.getElementById('rows').append(li);",
      "  }",
      "});",
    ].join("\n"),
  };
}

/** The lazily-loaded chunk, and the only place these endpoints are named. */
function chunkScript(): FixtureResponse {
  return {
    status: 200,
    headers: JS,
    body: [
      "export async function load() {",
      "  await fetch('/api/orders/pending');",
      "  await fetch('/api/orders/archive');",
      "}",
    ].join("\n"),
  };
}

export function dynamicSite(): FixtureApp {
  const stub = (title: string) => (): FixtureResponse => ({
    status: 200,
    headers: HTML,
    body: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
  });

  return {
    name: "dynamic-site",
    routes: [
      { method: "GET", path: "/", handler: shell },
      { method: "GET", path: "/app.js", handler: entryScript },
      { method: "GET", path: "/chunk-orders.js", handler: chunkScript },
      {
        method: "GET",
        path: "/api/rows",
        handler: (request) => {
          // Page-driven, not clock-driven: page 3 is always the last one.
          const page = Number(request.query.page ?? "1");
          const rows =
            page > 3
              ? []
              : [1, 2].map((index) => ({
                  href: `/rows/${(page - 1) * 2 + index}`,
                  label: `Row ${(page - 1) * 2 + index}`,
                }));
          return {
            status: 200,
            headers: JSON_HEADERS,
            body: JSON.stringify({ page, rows, has_more: page < 3 }),
          };
        },
      },
      { method: "GET", path: "/about", handler: stub("About") },
      { method: "GET", path: "/help", handler: stub("Help") },
      { method: "GET", path: "/settings", handler: stub("Settings") },
      { method: "GET", path: "/billing", handler: stub("Billing") },
      { method: "GET", path: "/team", handler: stub("Team") },
      { method: "GET", path: "/audit", handler: stub("Audit") },
      { method: "GET", path: "/rows/:id", handler: stub("Row") },
      {
        method: "GET",
        path: "/api/orders/pending",
        handler: () => ({ status: 200, headers: JSON_HEADERS, body: '{"orders":[]}' }),
      },
      {
        method: "GET",
        path: "/api/orders/archive",
        handler: () => ({ status: 200, headers: JSON_HEADERS, body: '{"orders":[]}' }),
      },
    ],
  };
}
