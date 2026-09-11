/**
 * Fixture: a page built from iframes — build plan §36.1, dev plan BR-M1-04.
 *
 * A separate app rather than a route added to `staticSite`, so the existing
 * golden baselines stay untouched and this scenario can grow without
 * perturbing them.
 *
 * Frames are where "attribute the observation to the right place" stops being
 * free. A scan that merges an iframe's requests into the top document reports
 * an attack surface that does not exist — third-party widget endpoints
 * presented as the target's own — and one that drops them misses the surface
 * that does. So this fixture gives the telemetry adapter something to get
 * wrong:
 *
 *   /frames          a top document with three frames
 *   /frames/panel    a same-origin child that fetches its own API
 *   /frames/deep     a child that nests a further frame
 *   /frames/leaf     the grandchild
 *   /frames/late     a frame added by script after load, not present in the
 *                    initial markup — the case a one-shot DOM read misses
 *   /api/panel       the endpoint only the panel frame ever calls
 *   /api/leaf        the endpoint only the grandchild ever calls
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
      `<head><title>${title}</title></head>`,
      "<body>",
      `<h1>${title}</h1>`,
      body,
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  };
}

export function framedSite(): FixtureApp {
  return {
    name: "framed-site",
    routes: [
      {
        method: "GET",
        path: "/frames",
        handler: () =>
          page(
            "Frames",
            [
              '<iframe src="/frames/panel" title="panel"></iframe>',
              '<iframe src="/frames/deep" title="deep"></iframe>',
              "<script>",
              // Added after load, so a crawler that reads the markup once and
              // stops never sees it.
              '  window.addEventListener("load", () => {',
              '    const frame = document.createElement("iframe");',
              '    frame.src = "/frames/late";',
              '    frame.title = "late";',
              "    document.body.appendChild(frame);",
              "  });",
              "</script>",
            ].join("\n"),
          ),
      },
      {
        method: "GET",
        path: "/frames/panel",
        handler: () =>
          page(
            "Panel",
            // This endpoint is reachable only from inside the frame, and must
            // be attributed to it rather than to the top document.
            '<script>fetch("/api/panel");</script>',
          ),
      },
      {
        method: "GET",
        path: "/frames/deep",
        handler: () => page("Deep", '<iframe src="/frames/leaf" title="leaf"></iframe>'),
      },
      {
        method: "GET",
        path: "/frames/leaf",
        handler: () => page("Leaf", '<script>fetch("/api/leaf");</script>'),
      },
      {
        method: "GET",
        path: "/frames/late",
        handler: () => page("Late", "<p>Added after load.</p>"),
      },
      {
        method: "GET",
        path: "/api/panel",
        handler: () => ({
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: '{ "frame": "panel" }\n',
        }),
      },
      {
        method: "GET",
        path: "/api/leaf",
        handler: () => ({
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: '{ "frame": "leaf" }\n',
        }),
      },
      {
        method: "GET",
        path: "/second",
        // A second top-level page, for asserting that one navigation's
        // execution contexts do not survive into the next.
        handler: () => page("Second", '<script>window.marker = "second";</script>'),
      },
    ],
  };
}
