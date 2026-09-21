/**
 * Fixture: a service that pushes back — build plan §8.6, §10C.7, §7.3;
 * dev plan BR-M1-30.
 *
 * Everything a scan has to survive without either giving up or getting
 * clever. Each behaviour is driven by the *request count*, never by a clock,
 * so the nth request always gets the nth answer:
 *
 *   `/api/burst`      200 for the first three, then 429 with `Retry-After`
 *   `/api/protected`  403 with a challenge page — the WAF shape
 *   `/api/login`      401 with `WWW-Authenticate` — the auth wall
 *   `/api/slow`       a response that arrives in pieces, slowly
 *   `/api/never`      a response that never arrives at all
 *
 * ## Why a counter rather than a timer
 *
 * A fixture that rate-limits by wall clock is a fixture whose test results
 * depend on how loaded the machine is. Counting requests gives the same
 * sequence of statuses every run, which is what lets a golden baseline
 * assert that the scan backed off *and then continued* rather than just
 * that it saw a 429 once.
 *
 * ## `/api/never` is the interesting one
 *
 * A request that hangs forever is how a scan discovers whether its deadlines
 * are real. Nothing else in this package can prove that a missing timeout
 * would hang the run, because every other endpoint answers.
 */
import type { FixtureApp, FixtureResponse, FixtureState } from "../types.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const HTML = { "content-type": "text/html; charset=utf-8" } as const;

/** Requests allowed before the limiter trips. */
export const BURST_ALLOWANCE = 3;
/** Requests refused before it lets traffic through again. */
export const THROTTLE_DURATION = 2;

interface Counters extends FixtureState {
  burst: number;
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FixtureResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) };
}

export function throttledApi(): FixtureApp {
  return {
    name: "throttled-api",
    seedState: (): Counters => ({ burst: 0 }),
    routes: [
      {
        method: "GET",
        path: "/",
        handler: () => ({
          status: 200,
          headers: HTML,
          body: [
            "<!doctype html>",
            '<html lang="en"><head><title>Throttled</title></head><body>',
            "<h1>Throttled service</h1>",
            '<a href="/api/burst">burst</a>',
            '<a href="/api/protected">protected</a>',
            '<a href="/api/login">login</a>',
            "<script>",
            // Fired from the page so a browser-driven scan meets the
            // limiter the same way a crawler does.
            "  for (let i = 0; i < 5; i += 1) fetch('/api/burst');",
            "</script>",
            "</body></html>",
          ].join("\n"),
        }),
      },
      {
        method: "GET",
        path: "/api/burst",
        handler: (_request, state) => {
          const counters = state as Counters;
          counters.burst += 1;
          const position = counters.burst;

          const cycle = BURST_ALLOWANCE + THROTTLE_DURATION;
          const inCycle = ((position - 1) % cycle) + 1;

          if (inCycle > BURST_ALLOWANCE) {
            // A real limiter tells you how long to wait. §8.6 wants the
            // scan to honour the header rather than invent its own delay,
            // and it can only be tested against one that sends it.
            return json(429, { error: "rate limited", retry_after: 2 }, { "retry-after": "2" });
          }
          return json(200, { ok: true, request: position });
        },
      },
      {
        method: "GET",
        path: "/api/protected",
        handler: () => ({
          status: 403,
          headers: {
            ...HTML,
            // The shape a WAF actually sends, down to the vendor header,
            // because that is what barrier classification keys on.
            server: "cloudfront",
            "x-amz-cf-id": "fixture",
          },
          body: [
            "<!doctype html>",
            "<html><head><title>Access denied</title></head><body>",
            "<h1>Request blocked</h1>",
            "<p>Please complete the security check to continue.</p>",
            "</body></html>",
          ].join("\n"),
        }),
      },
      {
        method: "GET",
        path: "/api/login",
        handler: () =>
          json(
            401,
            { error: "authentication required" },
            { "www-authenticate": 'Bearer realm="fixture"' },
          ),
      },
      {
        method: "GET",
        path: "/api/slow",
        handler: () => ({
          status: 200,
          headers: JSON_HEADERS,
          // Chunked, so a reader that gives up early gets a truncated body
          // rather than none — the case a "did the response complete?"
          // check has to tell apart from a clean 200.
          stream: (write, end) => {
            write('{"items":[');
            write('{"id":1},');
            setTimeout(() => {
              write('{"id":2}]}');
              end();
            }, 250);
          },
        }),
      },
      {
        method: "GET",
        path: "/api/never",
        handler: () => ({
          status: 200,
          headers: JSON_HEADERS,
          // Deliberately never calls `end`. The harness closes the socket
          // when the fixture shuts down, so this cannot leak past a test.
          stream: (write) => {
            write('{"waiting":');
          },
        }),
      },
    ],
  };
}
