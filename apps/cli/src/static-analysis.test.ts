import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { describe, expect, it } from "vitest";
import { analyzeCapturedScripts } from "./static-analysis.js";

/**
 * The stage that did not exist.
 *
 * `@browserrecon/collector-javascript-discovery` shipped a tree-sitter
 * analyzer, a triage ranking and a bounded pipeline in M2, all tested, and
 * nothing imported any of them. A scan of a real target captured 110
 * first-party bundles and reported one static API candidate — which was not
 * a candidate at all but a page the budget had cut off, borrowed from the
 * queue's skip list to fill the column.
 *
 * These assert the connection, from a literal event log: no browser, no
 * network, the same rule §1.2 puts on everything right of correlation.
 */

const ORIGIN = "https://shop.example.com";
let sequence = 0;

function event<T>(type: string, payload: T): EventEnvelope {
  sequence += 1;
  return createEnvelope({
    sequence,
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    session_id: "sess_0001",
    timestamp: "2026-01-15T10:00:00.000Z",
    type: type as never,
    provenance: "observed",
    auth_context: "anonymous",
    payload,
  });
}

/** A script fetched and captured, as the network collector records it. */
function script(url: string, source: string, resourceType = "Script"): EventEnvelope[] {
  const requestId = `r${sequence + 1}`;
  return [
    event("network_request", { requestId, url, method: "GET", resourceType }),
    event("network_response", {
      requestId,
      url,
      status: 200,
      mimeType: "text/javascript",
      body: { text: source },
    }),
  ];
}

const analyze = (events: readonly EventEnvelope[]): ReturnType<typeof analyzeCapturedScripts> =>
  analyzeCapturedScripts({
    events,
    firstPartyOrigins: [ORIGIN],
    pageOrigin: ORIGIN,
  });

describe("reading the bundles the scan captured", () => {
  it("finds the endpoints a bundle names", async () => {
    const result = await analyze(
      script(
        `${ORIGIN}/app.js`,
        `async function load(id){
           const a = await fetch("/api/v2/orders");
           const b = await fetch("/api/v2/orders/" + id);
           return [a, b];
         }`,
      ),
    );

    expect(result.analysed).toBe(1);
    expect(result.candidates.map((candidate) => candidate.path)).toContain("/api/v2/orders");
  });

  it("says where in the code each one was found", async () => {
    // §10A.3 requires a source location on every candidate: a path with no
    // file and line is something a reader cannot go and check.
    const result = await analyze(
      script(`${ORIGIN}/app.js`, `\nconst u = "/api/v2/orders";\nfetch(u);\n`),
    );

    const candidate = result.candidates.find((entry) => entry.path === "/api/v2/orders");
    expect(candidate?.sources[0]?.script).toBe(`${ORIGIN}/app.js`);
    expect(candidate?.sources[0]?.line).toBe(2);
  });

  it("merges one endpoint seen across several chunks", async () => {
    // A code-split application names the same path in a dozen chunks.
    // Reporting it a dozen times buries the distinct endpoints.
    const result = await analyze([
      ...script(`${ORIGIN}/chunk-a.js`, `fetch("/api/v2/orders")`),
      ...script(`${ORIGIN}/chunk-b.js`, `fetch("/api/v2/orders")`),
    ]);

    const orders = result.candidates.filter((entry) => entry.path === "/api/v2/orders");
    expect(orders).toHaveLength(1);
    expect(orders[0]?.sources.length).toBeGreaterThan(1);
  });

  it("ignores a response that carried no body", async () => {
    // A script the scan saw go past is not a script it can read. Counting
    // it as analysed is how `js_asset 115 of 115` came to sit beside one
    // static candidate.
    const requestId = "r-empty";
    const result = await analyze([
      event("network_request", {
        requestId,
        url: `${ORIGIN}/uncaptured.js`,
        method: "GET",
        resourceType: "Script",
      }),
      event("network_response", {
        requestId,
        url: `${ORIGIN}/uncaptured.js`,
        status: 200,
        mimeType: "text/javascript",
        body: { skipped: "too_large" },
      }),
    ]);

    expect(result.analysed).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("does not hand a captured API response to a JavaScript parser", async () => {
    // Found by probe: removing the resource-type filter broke nothing, so
    // nothing was asserting it. Response bodies are captured for APIs too,
    // and a JSON document parsed as JavaScript yields paths out of whatever
    // string values it happens to contain — candidates invented from data,
    // attributed to a file that is not code.
    const requestId = "r-json";
    const result = await analyze([
      event("network_request", {
        requestId,
        url: `${ORIGIN}/api/v2/orders`,
        method: "GET",
        resourceType: "Fetch",
      }),
      event("network_response", {
        requestId,
        url: `${ORIGIN}/api/v2/orders`,
        status: 200,
        mimeType: "application/json",
        body: { text: '{"next":"/api/v2/orders?page=2","items":[]}' },
      }),
    ]);

    expect(result.analysed).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("reads a bundle the server mislabelled", async () => {
    // Chrome's resource type is the answer to "what did the page ask for",
    // which is the better question than what the content-type header says.
    const result = await analyze(
      script(`${ORIGIN}/app.js`, `fetch("/api/v2/orders")`, "Other"),
    );
    expect(result.analysed).toBe(1);
  });

  it("collects configured API bases, and only the literal ones", async () => {
    // §10A.5: an unresolved expression must not be turned into a value. A
    // wrong base silently mis-correlates every candidate under it.
    const result = await analyze(
      script(
        `${ORIGIN}/config.js`,
        `const apiBase = "/api/v2";
         const other = { baseURL: window.ENV.ROOT };`,
      ),
    );

    expect(result.basePaths).toContain("/api/v2");
    expect(result.basePaths.every((path) => path.startsWith("/"))).toBe(true);
  });

  it("returns an empty result rather than throwing when nothing was captured", async () => {
    const result = await analyze([event("page_loaded", { url: ORIGIN })]);
    expect(result.analysed).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("reports what a bound refused rather than losing it", async () => {
    // §45: no silent loss. A budget of zero refuses everything, and the
    // count has to say so.
    const result = await analyzeCapturedScripts({
      events: script(`${ORIGIN}/app.js`, `fetch("/api/v2/orders")`),
      firstPartyOrigins: [ORIGIN],
      pageOrigin: ORIGIN,
      totalBudgetMs: -1,
    });

    expect(result.analysed).toBe(0);
    expect(Object.values(result.skipped).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
