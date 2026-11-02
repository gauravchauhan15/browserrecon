import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { describe, expect, it } from "vitest";
import { assemble } from "./assemble.js";

/**
 * The assembly, from a literal log — §1.2's rule, which is what makes this
 * file possible: no browser, no fixture, no network.
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

function call(
  url: string,
  options: { method?: string; mimeType?: string; resourceType?: string } = {},
): EventEnvelope[] {
  const requestId = `r${sequence + 1}`;
  return [
    event("network_request", {
      requestId,
      url,
      method: options.method ?? "GET",
      resourceType: options.resourceType ?? "Fetch",
      initiator: { type: "script", stack: [`f@${ORIGIN}/app.js:1:1`] },
    }),
    event("network_response", {
      requestId,
      url,
      status: 200,
      mimeType: options.mimeType ?? "application/json",
    }),
  ];
}

const build = (
  events: readonly EventEnvelope[],
  extra: Partial<Parameters<typeof assemble>[0]> = {},
): ReturnType<typeof assemble> =>
  assemble({
    sessionId: "sess_0001",
    target: ORIGIN,
    events,
    firstPartyOrigins: [ORIGIN],
    ...extra,
  });

const dimension = (
  model: ReturnType<typeof assemble>,
  name: string,
): { total: number } | undefined =>
  model.coverage.dimensions.find((entry) => entry.dimension === name);

describe("static candidates reach coverage from the parser, not the queue", () => {
  it("counts what the bundles named", () => {
    // This dimension used to be filled from the *queue's* skip list, which
    // has nothing to do with JavaScript: a scan that captured 110
    // first-party bundles reported one static API candidate, and that one
    // was a page the budget had cut off.
    const model = build(call(`${ORIGIN}/api/cart`), {
      staticCandidates: [
        { path: "/api/cart", confidence: "high", sources: [{ script: "a.js", line: 1 }] },
        {
          path: "/api/admin/users",
          confidence: "medium",
          sources: [{ script: "a.js", line: 9 }],
        },
      ],
    });

    expect(dimension(model, "static_api_candidate")?.total).toBe(2);
  });

  it("is absent, not zero, when no parser ran", () => {
    // §10C.2 keeps "we did not look" and "we looked and found nothing"
    // apart, and a dimension of zero reads as the second.
    const model = build(call(`${ORIGIN}/api/cart`));
    expect(model.staticApis).toBeUndefined();
    expect(dimension(model, "static_api_candidate")?.total ?? 0).toBe(0);
  });

  it("promotes a candidate only where the runtime called it", () => {
    const model = build(call(`${ORIGIN}/api/cart`), {
      staticCandidates: [
        { path: "/api/cart", confidence: "high", sources: [] },
        { path: "/api/admin/users", confidence: "high", sources: [] },
      ],
    });

    expect(model.staticApis?.counts.observed).toBe(1);
    expect(model.staticApis?.counts.unobserved).toBe(1);
  });

  it("correlates a candidate through a configured base", () => {
    const model = build(call(`${ORIGIN}/api/v2/orders`), {
      staticCandidates: [{ path: "/orders", confidence: "medium", sources: [] }],
      staticBasePaths: ["/api/v2"],
    });

    expect(model.staticApis?.counts.correlated).toBe(1);
  });
});

describe("the inventory is wider than what workflow detection sees", () => {
  const events = [
    ...call(`${ORIGIN}/api/cart`),
    ...call("https://api.vendor.example/v1/segment", { method: "POST", resourceType: "XHR" }),
  ];

  it("reports a third-party JSON endpoint", () => {
    const model = build(events);
    expect(model.api.apis.map((entry) => entry.role)).toContain("third_party_api");
  });

  it("keeps it out of the coverage denominator", () => {
    // Otherwise a tracker-heavy page looks under-explored for endpoints
    // this scan was never going to explore.
    const model = build(events);
    expect(dimension(model, "runtime_api")?.total).toBe(1);
  });
});

describe("a tool carries the page that published it", () => {
  it("keeps the registering page, for the report's diagram", () => {
    const model = build([
      event("webmcp_tool_discovered", {
        name: "cancel_order",
        url: `${ORIGIN}/account`,
        origin: ORIGIN,
        annotations: { destructiveHint: true },
      }),
    ]);

    expect(model.webmcp[0]?.page).toBe(`${ORIGIN}/account`);
    expect(model.webmcp[0]?.effect).toBe("destructive");
  });
});

describe("a barrier is recorded, never circumvented", () => {
  function blocked(url: string, status: number): EventEnvelope[] {
    const requestId = `r${sequence + 1}`;
    return [
      event("network_request", { requestId, url, method: "GET", resourceType: "Fetch" }),
      event("network_response", { requestId, url, status, mimeType: "application/json" }),
    ];
  }

  it("records what stopped the scan", () => {
    // §7.3's promise is about a list, and the list was fed from one source:
    // a failed login. A scan that met a 403 on every admin route and a 429
    // from the rate limiter reported no barriers at all, under a standing
    // sentence saying none had been circumvented — true, and about nothing.
    const model = build([
      ...blocked(`${ORIGIN}/api/admin/users`, 403),
      ...blocked(`${ORIGIN}/api/reports`, 429),
      ...blocked(`${ORIGIN}/api/me`, 401),
    ]);

    expect(model.barriers.map((barrier) => barrier.category).sort()).toEqual([
      "authentication",
      "authorization",
      "rate_limit",
    ]);
  });

  it("counts one barrier however many times it was met", () => {
    // A rate limiter answers 429 forty times in a scan. That is one barrier
    // met forty times, not forty findings.
    const model = build([
      ...blocked(`${ORIGIN}/api/reports?page=1`, 429),
      ...blocked(`${ORIGIN}/api/reports?page=2`, 429),
      ...blocked(`${ORIGIN}/api/reports?page=3`, 429),
    ]);
    expect(model.barriers).toHaveLength(1);
  });

  it("does not count a barrier as surface reached", () => {
    // §10C.2's `blocked`: in the denominator, out of the numerator. A
    // barrier that counted as coverage would make a locked-down application
    // look thoroughly explored.
    const model = build(blocked(`${ORIGIN}/api/admin/users`, 403));
    const barrier = model.coverage.dimensions.find((d) => d.dimension === "access_barrier");
    expect(barrier?.total).toBe(1);
    expect(barrier?.byStatus.observed).toBe(0);
    expect(barrier?.byStatus.blocked).toBe(1);
  });

  it("is not a barrier just because the response was an error", () => {
    // A 404 and a 500 are not access control. Counting them would bury the
    // three statuses that mean something under every broken link.
    const model = build([
      ...blocked(`${ORIGIN}/api/missing`, 404),
      ...blocked(`${ORIGIN}/api/broken`, 500),
    ]);
    expect(model.barriers).toEqual([]);
  });

  it("offers no way past any of them", () => {
    // §7.3. A remedy field on a barrier is where the suggestion would go,
    // so there is no remedy field.
    const model = build(blocked(`${ORIGIN}/api/admin/users`, 403));
    expect(Object.keys(model.barriers[0] ?? {}).sort()).toEqual([
      "category",
      "eventId",
      "evidence",
      "url",
    ]);
  });
});
