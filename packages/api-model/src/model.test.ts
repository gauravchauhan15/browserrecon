import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { describe, expect, it } from "vitest";
import { buildApiModel } from "./index.js";

/**
 * The model, built from a literal event log.
 *
 * §1.2's load-bearing rule made concrete: no browser, no fixture, no
 * network. If this file ever needs one, the boundary has been violated.
 */

const ORIGIN = "https://shop.example.com";
let sequence = 0;

function event<T>(type: string, payload: T, extra: Record<string, string> = {}): EventEnvelope {
  sequence += 1;
  return createEnvelope({
    sequence,
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    session_id: "sess_0001",
    timestamp: "2026-01-15T10:00:00.000Z",
    type: type as never,
    provenance: "observed",
    auth_context: "anonymous",
    ...extra,
    payload,
  });
}

interface RequestOptions {
  readonly method?: string;
  readonly status?: number;
  readonly mimeType?: string;
  readonly resourceType?: string;
  readonly initiator?: { type: string; url?: string; stack?: string[] };
  readonly postData?: string;
  readonly responseBody?: string;
}

/** A request/response pair, as telemetry would emit them. */
function call(url: string, options: RequestOptions = {}): EventEnvelope[] {
  const requestId = `r${sequence + 1}`;
  return [
    event("network_request", {
      requestId,
      url,
      method: options.method ?? "GET",
      resourceType: options.resourceType ?? "fetch",
      initiator: options.initiator ?? { type: "script", stack: [`f@${ORIGIN}/app.js:1:1`] },
      ...(options.postData === undefined ? {} : { postData: options.postData }),
      headers: { "content-type": "application/json" },
    }),
    event("network_response", {
      requestId,
      url,
      status: options.status ?? 200,
      mimeType: options.mimeType ?? "application/json",
      ...(options.responseBody === undefined ? {} : { body: { text: options.responseBody } }),
    }),
  ];
}

const build = (events: EventEnvelope[]) =>
  buildApiModel(events, { firstPartyOrigins: [ORIGIN] });

describe("building the model from a log", () => {
  it("produces one API per endpoint, however many times it was called", () => {
    const model = build([
      ...call(`${ORIGIN}/api/products/1`),
      ...call(`${ORIGIN}/api/products/2`),
      ...call(`${ORIGIN}/api/products/3`),
    ]);

    expect(model.apis).toHaveLength(1);
    expect(model.apis[0]?.observations).toHaveLength(3);
    expect(model.apis[0]?.url).toBe(`${ORIGIN}/api/products/{id}`);
  });

  it("numbers APIs by first appearance, not by sort order", () => {
    // api_0001 should be the first endpoint the scan met. Sorting here
    // would make the ids depend on the alphabet rather than the scan.
    const model = build([...call(`${ORIGIN}/api/zebra`), ...call(`${ORIGIN}/api/alpha`)]);
    expect(model.apis[0]?.url).toBe(`${ORIGIN}/api/zebra`);
    expect(model.apis[0]?.api_id).toBe("api_0001");
  });

  it("keeps methods apart on one path", () => {
    const model = build([
      ...call(`${ORIGIN}/api/orders`),
      ...call(`${ORIGIN}/api/orders`, { method: "POST", status: 201 }),
    ]);
    expect(model.apis.map((a) => a.method).sort()).toEqual(["GET", "POST"]);
  });

  it("records every status seen", () => {
    // One endpoint answering 200 and 403 is a finding, not noise.
    const model = build([
      ...call(`${ORIGIN}/api/account`),
      ...call(`${ORIGIN}/api/account`, { status: 403 }),
    ]);
    expect(model.apis[0]?.statuses).toEqual([200, 403]);
  });

  it("traces every API back to its events", () => {
    // §35B.5. An id that does not resolve is a claim, not an observation.
    const events = [...call(`${ORIGIN}/api/cart`)];
    const model = build(events);
    const known = new Set(events.map((e) => e.event_id));

    expect(model.apis[0]?.source_event_ids.length).toBeGreaterThan(0);
    for (const id of model.apis[0]?.source_event_ids ?? []) {
      expect(known.has(id), `${id} is not in the log`).toBe(true);
    }
  });

  it("counts requests that were never answered", () => {
    // A request with no response is not an endpoint that returned nothing;
    // it is a scan that ended mid-flight, and the difference matters.
    const model = build([
      ...call(`${ORIGIN}/api/a`),
      event("network_request", {
        requestId: "orphan",
        url: `${ORIGIN}/api/hanging`,
        method: "GET",
        initiator: { type: "script" },
      }),
    ]);
    expect(model.unanswered).toBe(1);
    expect(model.apis).toHaveLength(1);
  });
});

describe("only application traffic reaches the model", () => {
  it("excludes analytics and counts what it dropped", () => {
    // §17A.3. Twenty beacons in front of two endpoints is the same failure
    // as eighty product pages reported as eighty endpoints.
    const model = build([
      ...call(`${ORIGIN}/api/cart`),
      ...call("https://www.google-analytics.com/collect?e=pageview", {
        resourceType: "ping",
        mimeType: "text/plain",
      }),
      ...call("https://www.google-analytics.com/collect?e=click", {
        resourceType: "ping",
        mimeType: "text/plain",
      }),
    ]);

    expect(model.apis).toHaveLength(1);
    expect(model.apis[0]?.url).toBe(`${ORIGIN}/api/cart`);
    // Dropped, not silently: §45's no-silent-loss rule, and named by role
    // so a reader can see what kind of traffic was set aside.
    expect(model.excluded).toContainEqual({ role: "analytics_telemetry", count: 2 });
  });

  it("excludes stylesheets and images", () => {
    const model = build([
      ...call(`${ORIGIN}/api/cart`),
      ...call(`${ORIGIN}/app.css`, { resourceType: "Stylesheet", mimeType: "text/css" }),
      ...call(`${ORIGIN}/logo.png`, { resourceType: "Image", mimeType: "image/png" }),
    ]);
    expect(model.apis).toHaveLength(1);
  });

  it("can be widened deliberately, and only deliberately", () => {
    // A caller that wants analytics has to ask. Getting it because nobody
    // filtered is how the report fills with noise.
    const events = [
      ...call("https://www.google-analytics.com/collect", {
        resourceType: "ping",
        mimeType: "text/plain",
      }),
    ];
    expect(buildApiModel(events, { firstPartyOrigins: [ORIGIN] }).apis).toHaveLength(0);
    expect(
      buildApiModel(events, {
        firstPartyOrigins: [ORIGIN],
        roles: new Set(["analytics_telemetry"]),
      }).apis,
    ).toHaveLength(1);
  });

  it("excludes third-party traffic it cannot classify, rather than guessing", () => {
    // `unknown` is not `application_api`, and the default filter keeps only
    // the latter. A classifier that guessed "probably an API" for anything
    // third-party would put another site's endpoints in this one's surface.
    const model = build([
      ...call(`${ORIGIN}/api/cart`),
      ...call("https://widget.example.net/embed/config"),
    ]);
    expect(model.apis).toHaveLength(1);
    expect(model.excluded).toContainEqual({ role: "unknown", count: 1 });
  });
});

describe("context travels with each observation", () => {
  it("records the page a request was made from", () => {
    const model = build([
      event("navigation_committed", { url: `${ORIGIN}/checkout` }),
      ...call(`${ORIGIN}/api/cart`),
    ]);
    expect(model.apis[0]?.observations[0]?.page).toBe(`${ORIGIN}/checkout`);
  });

  it("attributes a request to the interaction that preceded it", () => {
    const model = build([
      event("interaction", { interaction_id: "int_0001", kind: "click" }),
      ...call(`${ORIGIN}/api/cart`, { method: "POST", status: 201 }),
    ]);
    expect(model.apis[0]?.observations[0]?.interactionId).toBe("int_0001");
  });

  it("stops attributing once the page has changed", () => {
    // A request made after a navigation was not caused by a click on the
    // page that is gone. Left unbounded, one click would be credited with
    // every request for the rest of the scan.
    const model = build([
      event("interaction", { interaction_id: "int_0001", kind: "click" }),
      event("navigation_committed", { url: `${ORIGIN}/next` }),
      ...call(`${ORIGIN}/api/after`),
    ]);
    expect(model.apis[0]?.observations[0]?.interactionId).toBeUndefined();
  });

  it("carries the auth context of the identity that produced it", () => {
    // §12.3. Without it, a multi-role scan merges an admin's view and an
    // anonymous visitor's into one surface that never existed.
    const model = build([...call(`${ORIGIN}/api/cart`)]);
    expect(model.apis[0]?.observations[0]?.authContext).toBe("anonymous");
  });
});

describe("causality", () => {
  it("credits the script Chrome named", () => {
    const model = build([
      ...call(`${ORIGIN}/api/cart`, {
        initiator: { type: "script", stack: [`submit@${ORIGIN}/checkout.js:182:14`] },
      }),
    ]);
    const edge = model.apis[0]?.caused_by.find((e) => e.target.startsWith("script:"));
    expect(edge?.kind).toBe("direct");
    expect(edge?.target).toContain("checkout.js");
  });

  it("does not invent an edge from adjacency", () => {
    // §15, the whole point. Two requests in order are two requests in
    // order; presenting that as a dependency invents a requirement nobody
    // can act on.
    const model = build([
      ...call(`${ORIGIN}/api/first`, { initiator: { type: "parser" } }),
      ...call(`${ORIGIN}/api/second`, { initiator: { type: "parser" } }),
    ]);
    const second = model.apis.find((a) => a.url.endsWith("/second"));
    expect(second?.caused_by).toEqual([]);
    expect(second?.depends_on).toEqual([]);
  });

  it("invents no edge for an endpoint called repeatedly either", () => {
    // Found by probing: the test above uses two endpoints with one
    // observation each, so an implementation that added an edge whenever a
    // bucket had several observations passed it untouched. Repetition is
    // the case where "these must be related" is most tempting and least
    // supported.
    const model = build([
      ...call(`${ORIGIN}/api/poll`, { initiator: { type: "parser" } }),
      ...call(`${ORIGIN}/api/poll`, { initiator: { type: "parser" } }),
      ...call(`${ORIGIN}/api/poll`, { initiator: { type: "parser" } }),
    ]);
    expect(model.apis[0]?.observations).toHaveLength(3);
    expect(model.apis[0]?.caused_by).toEqual([]);
  });

  it("points every edge at something the log actually contains", () => {
    // An edge to an id nothing resolves is worse than no edge: it reads as
    // evidence and leads nowhere.
    const events = [
      event("interaction", { interaction_id: "int_0001", kind: "click" }),
      ...call(`${ORIGIN}/api/cart`, {
        initiator: { type: "script", stack: [`f@${ORIGIN}/checkout.js:1:1`] },
      }),
      ...call(`${ORIGIN}/api/cart`, {
        initiator: { type: "script", stack: [`f@${ORIGIN}/checkout.js:2:1`] },
      }),
    ];
    const model = build(events);
    const serialized = JSON.stringify(events);

    for (const edge of model.apis[0]?.caused_by ?? []) {
      const [kind, ...rest] = edge.target.split(":");
      const value = rest.join(":");
      expect(["script", "interaction"], `unexpected edge kind ${kind}`).toContain(kind);
      expect(serialized, `${edge.target} appears nowhere in the log`).toContain(value);
    }
  });

  it("states a basis for every edge it does produce", () => {
    const model = build([
      event("interaction", { interaction_id: "int_0001", kind: "click" }),
      ...call(`${ORIGIN}/api/cart`),
    ]);
    for (const edge of model.apis[0]?.caused_by ?? []) {
      expect(edge.basis.length, edge.target).toBeGreaterThan(10);
    }
  });
});

describe("payloads", () => {
  it("summarises a request body without carrying its values", () => {
    const model = build([
      ...call(`${ORIGIN}/api/orders`, {
        method: "POST",
        status: 201,
        postData: '{"email":"a@b.com","quantity":2}',
      }),
    ]);

    const shape = model.apis[0]?.requestShape;
    expect(shape?.fields.map((f) => f.path)).toEqual(["email", "quantity"]);
    expect(JSON.stringify(shape)).not.toContain("a@b.com");
  });

  it("summarises a response body too", () => {
    const model = build([
      ...call(`${ORIGIN}/api/cart`, { responseBody: '{"total":42,"currency":"GBP"}' }),
    ]);
    expect(model.apis[0]?.responseShape?.fields.map((f) => f.path)).toEqual([
      "currency",
      "total",
    ]);
  });

  it("omits the shape entirely when no body was ever seen", () => {
    // An empty shape reads as "we looked and it had no fields". Absent says
    // "there was nothing to look at", which is what happened.
    const model = build([...call(`${ORIGIN}/api/ping`)]);
    expect(model.apis[0]?.requestShape).toBeUndefined();
  });

  it("records query parameters against the endpoint", () => {
    const model = build([
      ...call(`${ORIGIN}/api/search?q=shoes&page=1`),
      ...call(`${ORIGIN}/api/search?q=hats&page=2`),
    ]);
    expect(model.apis).toHaveLength(1);
    expect(model.apis[0]?.parameters.map((p) => p.name)).toEqual(["page", "q"]);
  });

  it("keeps a token parameter's name and drops its value", () => {
    const model = build([...call(`${ORIGIN}/api/data?access_token=eyJhbGciOi.secret`)]);
    const serialized = JSON.stringify(model.apis[0]?.parameters);
    expect(serialized).toContain("access_token");
    expect(serialized).not.toContain("eyJhbGciOi");
  });
});

describe("determinism", () => {
  it("produces the same model from the same log", () => {
    const events = [
      event("navigation_committed", { url: `${ORIGIN}/` }),
      ...call(`${ORIGIN}/api/b?z=1&a=2`),
      ...call(`${ORIGIN}/api/a`, { postData: '{"x":1,"a":2}' }),
    ];
    expect(JSON.stringify(buildApiModel(events))).toBe(JSON.stringify(buildApiModel(events)));
  });
});
