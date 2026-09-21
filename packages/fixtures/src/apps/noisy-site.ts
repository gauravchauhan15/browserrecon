/**
 * Fixture: a page mostly made of other people's code — dev plan BR-M1-30;
 * build plan §14 (origin classification), §17A.
 *
 * The realistic ratio. A page's own two API calls arrive alongside twenty
 * requests to analytics, tag managers, fonts, session replay and a chat
 * widget — and a scan that reports all twenty-two as "the attack surface"
 * has buried the two that matter.
 *
 * ## Third-party means a different origin, not a different path
 *
 * `thirdPartyOrigin` is a parameter rather than a hard-coded host because
 * origin classification has to be tested against a *genuinely* different
 * origin, and the only way to get one without leaving the machine is a
 * second fixture server on a second port. A test starts two and wires one
 * into the other.
 *
 * Called with no argument the third-party URLs are same-origin under
 * `/vendor/`. That keeps this app in `ALL_FIXTURE_APPS` (which builds every
 * app with no arguments) and still exercises the noise-volume case, but it
 * deliberately does *not* exercise cross-origin classification — a test that
 * needs that must pass the origin in. Saying so here because a same-origin
 * fixture quietly standing in for a cross-origin one is how a
 * classification bug survives a green suite.
 */
import type { FixtureApp, FixtureResponse } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JS = { "content-type": "text/javascript; charset=utf-8" } as const;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const GIF = { "content-type": "image/gif" } as const;
const CSS = { "content-type": "text/css; charset=utf-8" } as const;

/**
 * The smallest valid GIF, built from char codes.
 *
 * Written this way rather than as a string literal because the bytes are
 * control characters, and a source file carrying them raw is one that
 * editors, diffs and copy-paste all quietly mangle.
 */
const ONE_PIXEL_GIF = String.fromCharCode(
  0x47,
  0x49,
  0x46,
  0x38,
  0x39,
  0x61,
  0x01,
  0x00,
  0x01,
  0x00,
  0x80,
  0x00,
  0x00,
  0xff,
  0xff,
  0xff,
  0x00,
  0x00,
  0x00,
  0x21,
  0xf9,
  0x04,
  0x01,
  0x00,
  0x00,
  0x00,
  0x00,
  0x2c,
  0x00,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
  0x02,
  0x02,
  0x44,
  0x01,
  0x00,
  0x3b,
);

/** Paths a third party would serve. Named as the real ones are. */
export const VENDOR_SCRIPTS = [
  "/vendor/analytics.js",
  "/vendor/gtm.js",
  "/vendor/session-replay.js",
  "/vendor/chat-widget.js",
  "/vendor/ads.js",
] as const;

/** Beacons: fire-and-forget, and the bulk of the volume. */
export const BEACON_PATHS = [
  "/vendor/collect?e=pageview",
  "/vendor/collect?e=click",
  "/vendor/px.gif?id=1",
  "/vendor/px.gif?id=2",
  "/vendor/rum",
] as const;

/** The page's own API. Two calls, in among all of the above. */
export const FIRST_PARTY_API = ["/api/session", "/api/catalog"] as const;

export interface NoisySiteOptions {
  /**
   * Origin serving the vendor assets, e.g. another fixture's `origin`.
   *
   * Omitted, they are served from this app under the same origin — which
   * tests volume but not classification.
   */
  readonly thirdPartyOrigin?: string | undefined;
}

export function noisySite(options: NoisySiteOptions = {}): FixtureApp {
  const vendor = options.thirdPartyOrigin ?? "";
  const at = (path: string): string => `${vendor}${path}`;

  const shell = (): FixtureResponse => ({
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en"><head><title>Noisy</title>',
      `<link rel="stylesheet" href="${at("/vendor/fonts.css")}">`,
      "</head><body>",
      "<h1>Shop</h1>",
      '<a href="/catalog">Catalog</a> <a href="/basket">Basket</a>',
      "<script>",
      `  for (const src of ${JSON.stringify(VENDOR_SCRIPTS.map(at))}) {`,
      "    const script = document.createElement('script');",
      "    script.src = src; script.async = true;",
      "    document.head.append(script);",
      "  }",
      `  for (const beacon of ${JSON.stringify(BEACON_PATHS.map(at))}) fetch(beacon);`,
      // The two that matter, indistinguishable by volume.
      `  for (const api of ${JSON.stringify([...FIRST_PARTY_API])}) fetch(api);`,
      "</script>",
      "</body></html>",
    ].join("\n"),
  });

  const stub = (title: string) => (): FixtureResponse => ({
    status: 200,
    headers: HTML,
    body: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
  });

  const script = (global: string) => (): FixtureResponse => ({
    status: 200,
    headers: JS,
    body: `window.${global} = 1;`,
  });

  return {
    name: "noisy-site",
    routes: [
      { method: "GET", path: "/", handler: shell },
      { method: "GET", path: "/catalog", handler: stub("Catalog") },
      { method: "GET", path: "/basket", handler: stub("Basket") },
      {
        method: "GET",
        path: "/api/session",
        handler: () => ({ status: 200, headers: JSON_HEADERS, body: '{"user":null}' }),
      },
      {
        method: "GET",
        path: "/api/catalog",
        handler: () => ({ status: 200, headers: JSON_HEADERS, body: '{"items":[]}' }),
      },

      // Served here too, so the app works standalone as well as paired.
      {
        method: "GET",
        path: "/vendor/fonts.css",
        handler: () => ({ status: 200, headers: CSS, body: "body{font-family:sans-serif}" }),
      },
      { method: "GET", path: "/vendor/analytics.js", handler: script("__analytics") },
      { method: "GET", path: "/vendor/gtm.js", handler: script("__gtm") },
      { method: "GET", path: "/vendor/session-replay.js", handler: script("__replay") },
      { method: "GET", path: "/vendor/chat-widget.js", handler: script("__chat") },
      { method: "GET", path: "/vendor/ads.js", handler: script("__ads") },
      { method: "GET", path: "/vendor/collect", handler: () => ({ status: 204 }) },
      { method: "GET", path: "/vendor/rum", handler: () => ({ status: 204 }) },
      {
        method: "GET",
        path: "/vendor/px.gif",
        handler: () => ({ status: 200, headers: GIF, body: ONE_PIXEL_GIF }),
      },
    ],
  };
}
