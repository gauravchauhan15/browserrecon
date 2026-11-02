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
    // `unknown` is not an API role, and nothing promotes it. A classifier
    // that guessed "probably an API" for anything third-party would put
    // another site's endpoints in this one's surface.
    //
    // The distinguishing fact is the payload: this response carries none,
    // so there is nothing to say it is an endpoint rather than a widget's
    // own business.
    const model = build([
      ...call(`${ORIGIN}/api/cart`),
      ...call("https://widget.example.net/embed/config", { mimeType: "text/html" }),
    ]);
    expect(model.apis).toHaveLength(1);
    expect(model.excluded).toContainEqual({ role: "unknown", count: 1 });
  });

  it("keeps a third-party JSON endpoint, labelled as one", () => {
    // The other half of the same rule. A JSON body fetched by application
    // code is an endpoint whoever runs the host: it takes parameters, it
    // answers to this page, and leaving it out was how an application's own
    // API gateway — one subdomain over, so not an origin match — went
    // missing from its inventory.
    //
    // Its own role rather than `application_api`, so workflow detection and
    // the coverage denominator can keep excluding it by name.
    const model = build([...call("https://api.vendor.example/v1/segment", { method: "POST" })]);
    expect(model.apis).toHaveLength(1);
    expect(model.apis[0]?.role).toBe("third_party_api");
  });

  it("treats a host one subdomain over as the application's own", () => {
    // `https://shop.example.com` serving pages and `api.example.com`
    // serving its endpoints is the normal shape of a real application, and
    // origin equality alone called the second one somebody else's.
    const model = build([...call("https://api.example.com/v1/cart")]);
    expect(model.apis[0]?.role).toBe("application_api");
  });

  it("keeps authentication endpoints, which workflow detection asks for", () => {
    // §17A.3 lists `auth_infrastructure` under workflow detection, and the
    // model's default filter used to drop it before any consumer could ask
    // — so a login POST, the most interesting request on most
    // applications, could not appear in the inventory at all.
    const model = build([...call(`${ORIGIN}/auth/login`, { method: "POST" })]);
    expect(model.apis).toHaveLength(1);
    expect(model.apis[0]?.role).toBe("auth_infrastructure");
  });
});

describe("a request the scan never saw answered", () => {
  /** A request with no response — the scan ended while it was in flight. */
  function unanswered(url: string, resourceType = "Fetch"): EventEnvelope {
    return event("network_request", {
      requestId: `r${sequence + 1}`,
      url,
      method: "GET",
      resourceType,
      initiator: { type: "script", stack: [`f@${ORIGIN}/app.js:1:1`] },
    });
  }

  it("is still an endpoint the application called", () => {
    // §45: no silent loss. The model only ever opened a bucket on the
    // response, so a call whose answer had not arrived when the budget ran
    // out vanished — counted in `unanswered` and listed nowhere.
    //
    // Exactly how a real scan of the reference application reported an API inventory of
    // `None`: it called `data-search.apigw.example.com/v1/suggestions/`,
    // the session ended before the response landed, and the one endpoint in
    // the log did not reach the report derived from it.
    const model = build([unanswered(`${ORIGIN}/api/suggestions`)]);

    expect(model.apis).toHaveLength(1);
    expect(model.apis[0]?.url).toContain("/api/suggestions");
    expect(model.unanswered).toBe(1);
  });

  it("carries no status, because none was observed", () => {
    // The report renders an absent status as "no response". Inventing one
    // would turn "we do not know" into a finding.
    const model = build([unanswered(`${ORIGIN}/api/suggestions`)]);
    expect(model.apis[0]?.statuses).toEqual([]);
    expect(model.apis[0]?.observations[0]?.status).toBeUndefined();
  });

  it("does not list a page or an image that failed to load", () => {
    // A document that never arrived is a page that failed to load, which is
    // a different fact and not an API.
    const model = build([
      unanswered(`${ORIGIN}/about`, "Document"),
      unanswered(`${ORIGIN}/hero.png`, "Image"),
    ]);
    expect(model.apis).toEqual([]);
    expect(model.unanswered).toBe(2);
  });

  it("does not list a request whose resource type was never recorded", () => {
    // Found by probe: removing the resource-type guard broke nothing here,
    // because `Document` and `Image` are already excluded by their role.
    // What the guard actually protects is the case with no resource type at
    // all — which falls through every role rule to `application_api`, and
    // would admit any unanswered first-party request as an endpoint.
    const model = build([unanswered(`${ORIGIN}/api/suggestions`, "")]);
    expect(model.apis).toEqual([]);
  });

  it("does not list a request the browser abandoned", () => {
    // The distinction the §18.1 control fixture forced. `fetch(beacon)`
    // with nothing awaiting it is cancelled the moment the page navigates —
    // which is what an analytics beacon *is* — and in a model keyed on
    // responses it looks exactly like a call the budget cut off. Admitting
    // both put `/vendor/collect` in the attack surface.
    //
    // The log already tells them apart: one has a `network_failed` event
    // and the other has nothing after the request.
    const requestId = "r-cancelled";
    const model = build([
      event("network_request", {
        requestId,
        url: `${ORIGIN}/vendor/collect`,
        method: "GET",
        resourceType: "Fetch",
        initiator: { type: "script", stack: [`f@${ORIGIN}/app.js:1:1`] },
      }),
      event("network_failed", {
        requestId,
        url: `${ORIGIN}/vendor/collect`,
        errorText: "net::ERR_ABORTED",
        canceled: true,
      }),
    ]);

    expect(model.apis).toEqual([]);
    // Counted, though. §45: it still happened.
    expect(model.unanswered).toBe(1);
  });

  it("does not list a third-party host that simply did not answer", () => {
    // With no response there is no content type, so the payload rules
    // cannot run. Admitting third-party requests here would be guessing,
    // and "a vendor did not reply" is not a finding about this target.
    const model = build([unanswered("https://api.vendor.example/v1/segment")]);
    expect(model.apis).toEqual([]);
  });

  it("does not duplicate an endpoint that was answered elsewhere", () => {
    // One call answered, a second still in flight. Two buckets would read
    // as two endpoints.
    const model = build([...call(`${ORIGIN}/api/cart`), unanswered(`${ORIGIN}/api/cart`)]);
    expect(model.apis).toHaveLength(1);
    expect(model.apis[0]?.statuses).toEqual([200]);
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
      event("interaction", { interactionId: "int_0001", kind: "click" }),
      ...call(`${ORIGIN}/api/cart`, { method: "POST", status: 201 }),
    ]);
    expect(model.apis[0]?.observations[0]?.interactionId).toBe("int_0001");
  });

  it("stops attributing once the page has changed", () => {
    // A request made after a navigation was not caused by a click on the
    // page that is gone. Left unbounded, one click would be credited with
    // every request for the rest of the scan.
    const model = build([
      event("interaction", { interactionId: "int_0001", kind: "click" }),
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
      event("interaction", { interactionId: "int_0001", kind: "click" }),
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
      event("interaction", { interactionId: "int_0001", kind: "click" }),
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

describe("§17A.2's repeat signal reaches the classifier", () => {
  /**
   * The seam, not the rule. `classifyTraffic` has always known how to
   * recognise a heartbeat, and its own tests pass because they hand it an
   * interval. The model passed a running count and no interval at all, which
   * makes `looksLikePolling` return false on its first line — so no scan has
   * ever filed a single request as `polling_heartbeat`, and every heartbeat
   * went into the API inventory and on into workflow detection.
   */
  const at = (
    url: string,
    msSinceEpoch: number,
    options: RequestOptions = {},
  ): EventEnvelope[] =>
    call(url, options).map((envelope) => ({
      ...envelope,
      timestamp: new Date(msSinceEpoch).toISOString(),
    }));

  it("recognises a timer as polling and keeps it out of the API model", () => {
    const events = [
      event("navigation_committed", { url: `${ORIGIN}/` }),
      ...[0, 5_000, 10_000, 15_000, 20_000].flatMap((ms) => at(`${ORIGIN}/api/heartbeat`, ms)),
      ...at(`${ORIGIN}/api/orders`, 1_000),
    ];
    const model = build(events);

    expect(model.apis.map((api) => api.identity.pathTemplate)).toEqual(["/api/orders"]);
    expect(model.excluded).toContainEqual({ role: "polling_heartbeat", count: 5 });
  });

  it("does not call an endpoint a person kept clicking a heartbeat", () => {
    // The counterweight §17A.2 names: the interaction signal outranks the
    // interval, because a person clicking a reload button five times can
    // produce gaps as even as a timer's.
    const events = [
      event("navigation_committed", { url: `${ORIGIN}/` }),
      ...[0, 5_000, 10_000, 15_000, 20_000].flatMap((ms) => [
        event("interaction", { interactionId: `int_${ms}` }),
        ...at(`${ORIGIN}/api/inbox`, ms),
      ]),
    ];
    const model = build(events);

    expect(model.apis.map((api) => api.identity.pathTemplate)).toEqual(["/api/inbox"]);
  });

  it("does not call an uneven repeat a heartbeat", () => {
    // Jitter above §17A.2's 25% is a person or a queue, not a clock.
    const events = [0, 400, 9_000, 9_200, 30_000].flatMap((ms) =>
      at(`${ORIGIN}/api/events`, ms),
    );
    expect(build(events).apis).toHaveLength(1);
  });

  it("judges an endpoint once, not once per call", () => {
    // The compounding half of the defect. A bucket takes the role of its
    // first observation and never revises it, so a running count could not
    // have promoted anything to `polling_heartbeat` after the first call
    // however it behaved afterwards — the endpoint would have kept two
    // observations in the model and dropped the rest.
    const events = [0, 5_000, 10_000, 15_000].flatMap((ms) => at(`${ORIGIN}/api/ping`, ms));
    const model = build(events);

    expect(model.apis).toEqual([]);
    expect(model.excluded).toContainEqual({ role: "polling_heartbeat", count: 4 });
  });
});

describe("an endpoint classifies the same way whether or not it was answered", () => {
  it("does not promote a heartbeat because its last response never landed", () => {
    // Found by the M3 gate on the fixture built to be noisy. A beacon fired
    // on every page load is `polling_heartbeat` while its responses arrive;
    // the one still in flight when the scan ended came back
    // `application_api` and reached the attack surface. One endpoint, two
    // verdicts, decided by a race with the budget.
    //
    // §17A.2's repeat statistics are measured over the whole log, so they
    // are as available for an unanswered request as for an answered one.
    const beacon = `${ORIGIN}/vendor/collect`;
    const events = [
      ...call(beacon, { mimeType: "" }),
      ...call(beacon, { mimeType: "" }),
      ...call(beacon, { mimeType: "" }),
      // A fourth call, still in flight.
      event("network_request", {
        requestId: `r${sequence + 1}`,
        url: beacon,
        method: "GET",
        resourceType: "Fetch",
        initiator: { type: "script", stack: [`f@${ORIGIN}/app.js:1:1`] },
      }),
    ];

    // Spread the three answered calls over a stable interval, as a timer
    // would: §17A.2 needs a period before it will call anything a heartbeat.
    const spaced = events.map((envelope, index) => ({
      ...envelope,
      timestamp: new Date(Date.parse(envelope.timestamp) + index * 2_000).toISOString(),
    }));

    const model = buildApiModel(spaced, { firstPartyOrigins: [ORIGIN] });
    expect(model.apis.map((entry) => entry.url)).not.toContain(`${ORIGIN}/vendor/collect`);
  });
});
