import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { describe, expect, it } from "vitest";
import { buildApiModel, buildSequences, meaningfulSequences } from "./index.js";

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
  path: string,
  options: { method?: string; status?: number; resourceType?: string; mimeType?: string } = {},
) {
  const requestId = `r${sequence + 1}`;
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  return [
    event("network_request", {
      requestId,
      url,
      method: options.method ?? "GET",
      resourceType: options.resourceType ?? "fetch",
      initiator: { type: "script", stack: [`f@${ORIGIN}/checkout.js:1:1`] },
    }),
    event("network_response", {
      requestId,
      url,
      status: options.status ?? 200,
      mimeType: options.mimeType ?? "application/json",
    }),
  ];
}

const sequencesOf = (events: EventEnvelope[]) =>
  buildSequences(buildApiModel(events, { firstPartyOrigins: [ORIGIN] }));

describe("§17: ordered sequences", () => {
  it("numbers positions in envelope order", () => {
    const model = sequencesOf([
      event("navigation_committed", { url: `${ORIGIN}/checkout` }),
      ...call("/api/cart", { method: "POST", status: 201 }),
      ...call("/api/address"),
      ...call("/api/order/validate", { method: "POST" }),
      ...call("/api/order", { method: "POST", status: 201 }),
    ]);

    const positions = model.sequences[0]?.positions ?? [];
    expect(positions.map((p) => p.step)).toEqual([1, 2, 3, 4]);
    expect(positions.map((p) => p.url.replace(ORIGIN, ""))).toEqual([
      "/api/cart",
      "/api/address",
      "/api/order/validate",
      "/api/order",
    ]);
  });

  it("gives each position its neighbours", () => {
    const model = sequencesOf([...call("/api/a"), ...call("/api/b"), ...call("/api/c")]);
    const positions = model.sequences[0]?.positions ?? [];

    expect(positions[0]?.previous).toEqual([]);
    expect(positions[1]?.previous).toHaveLength(1);
    expect(positions[1]?.next).toHaveLength(1);
    expect(positions[2]?.next).toEqual([]);
  });

  it("carries page, interaction and auth context into every position", () => {
    const model = sequencesOf([
      event("navigation_committed", { url: `${ORIGIN}/checkout` }),
      event("interaction", { interactionId: "int_0001" }),
      ...call("/api/cart", { method: "POST", status: 201 }),
    ]);
    const position = model.sequences[0]?.positions[0];

    expect(position?.page).toBe(`${ORIGIN}/checkout`);
    expect(position?.interactionId).toBe("int_0001");
    expect(position?.authContext).toBe("anonymous");
    expect(position?.initiator?.script).toContain("checkout.js");
  });

  it("traces each position to its event", () => {
    const events = [...call("/api/cart")];
    const model = sequencesOf(events);
    const ids = new Set(events.map((e) => e.event_id));
    expect(ids.has(model.sequences[0]?.positions[0]?.eventId ?? "")).toBe(true);
  });
});

describe("§15: concurrency is not a dependency chain", () => {
  it("marks requests issued together as parallel", () => {
    // The single most misleading thing an API model can say is that B needs
    // A when they simply both fired. A reader acting on it tries to exploit
    // an ordering that was never required.
    const requests = ["/api/cart", "/api/user", "/api/config"];
    const events: EventEnvelope[] = [];
    const ids = requests.map((path, index) => {
      const id = `par${index}`;
      events.push(
        event("network_request", {
          requestId: id,
          url: `${ORIGIN}${path}`,
          method: "GET",
          resourceType: "fetch",
          initiator: { type: "script" },
        }),
      );
      return id;
    });
    for (const id of ids) {
      events.push(
        event("network_response", {
          requestId: id,
          url: `${ORIGIN}/x`,
          status: 200,
          mimeType: "application/json",
        }),
      );
    }

    const model = sequencesOf(events);
    const positions = model.sequences[0]?.positions ?? [];
    expect(positions).toHaveLength(3);
    for (const position of positions) {
      expect(position.parallel_with.length, position.url).toBeGreaterThan(0);
    }
  });

  it("does not mark sequential requests as parallel", () => {
    // A request issued after the previous one's response came back is a
    // sequence, and calling it concurrent would hide a real ordering.
    const model = sequencesOf([...call("/api/a"), ...call("/api/b"), ...call("/api/c")]);
    const positions = model.sequences[0]?.positions ?? [];
    expect(positions[0]?.parallel_with).toEqual([]);
  });
});

describe("§17A.3: application traffic only", () => {
  it("leaves analytics out of the sequence", () => {
    // An analytics beacon between two checkout calls is not step 3 of
    // checkout.
    const model = sequencesOf([
      ...call("/api/cart", { method: "POST", status: 201 }),
      ...call("https://www.google-analytics.com/collect", {
        resourceType: "ping",
        mimeType: "text/plain",
      }),
      ...call("/api/order", { method: "POST", status: 201 }),
    ]);

    const positions = model.sequences[0]?.positions ?? [];
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => p.url)).not.toContain(
      "https://www.google-analytics.com/collect",
    );
  });

  it("counts what it left out rather than dropping it silently", () => {
    const events = [
      ...call("/api/cart"),
      ...call("https://www.google-analytics.com/collect", {
        resourceType: "ping",
        mimeType: "text/plain",
      }),
    ];
    const model = buildSequences(
      buildApiModel(events, {
        firstPartyOrigins: [ORIGIN],
        roles: new Set(["application_api", "analytics_telemetry"]),
      }),
    );
    expect(model.excluded.analytics_telemetry).toBe(1);
  });
});

describe("what breaks a sequence", () => {
  it("starts a new one at a navigation", () => {
    const model = sequencesOf([
      event("navigation_committed", { url: `${ORIGIN}/a` }),
      ...call("/api/one"),
      event("navigation_committed", { url: `${ORIGIN}/b` }),
      ...call("/api/two"),
    ]);
    expect(model.sequences).toHaveLength(2);
  });

  it("starts a new one after a long quiet gap", () => {
    // A page that sits idle and then makes an unrelated call has made two
    // sequences. Without a gap rule every call on a long-lived SPA ends up
    // in one sequence that describes nothing.
    const events = [...call("/api/one")];
    for (let n = 0; n < 60; n += 1) events.push(event("console_message", { text: "noise" }));
    events.push(...call("/api/two"));

    const model = buildSequences(buildApiModel(events, { firstPartyOrigins: [ORIGIN] }), {
      gapThreshold: 20,
    });
    expect(model.sequences).toHaveLength(2);
  });

  it("offers the ones worth calling flows, without discarding the rest", () => {
    // "This page made one call" is still a fact about the page.
    const model = sequencesOf([
      event("navigation_committed", { url: `${ORIGIN}/a` }),
      ...call("/api/only"),
      event("navigation_committed", { url: `${ORIGIN}/b` }),
      ...call("/api/x"),
      ...call("/api/y"),
    ]);

    expect(model.sequences).toHaveLength(2);
    expect(meaningfulSequences(model)).toHaveLength(1);
  });

  it("does not call a polled endpoint a flow", () => {
    const model = sequencesOf([
      ...call("/api/heartbeat"),
      ...call("/api/heartbeat"),
      ...call("/api/heartbeat"),
    ]);
    expect(meaningfulSequences(model)).toHaveLength(0);
  });
});

describe("determinism", () => {
  it("produces the same sequences from the same log", () => {
    const events = [
      event("navigation_committed", { url: `${ORIGIN}/checkout` }),
      ...call("/api/cart", { method: "POST", status: 201 }),
      ...call("/api/order", { method: "POST", status: 201 }),
    ];
    expect(JSON.stringify(sequencesOf(events))).toBe(JSON.stringify(sequencesOf(events)));
  });
});

describe("depends_on is built from value flow, not adjacency", () => {
  const withBody = (path: string, body: string, method = "GET") => {
    const requestId = `r${sequence + 1}`;
    const url = `${ORIGIN}${path}`;
    return [
      event("network_request", {
        requestId,
        url,
        method,
        resourceType: "fetch",
        initiator: { type: "script" },
      }),
      event("network_response", {
        requestId,
        url,
        status: 200,
        mimeType: "application/json",
        body: { text: body },
      }),
    ];
  };

  it("finds the edge when an identifier flows forward", () => {
    // §15's honest alternative to guessing from adjacency: the second
    // request could not have been built without the first's answer.
    const id = "8f14e45fceea167a5a36dedd4bea2543";
    const model = buildApiModel(
      [
        ...withBody("/api/cart", JSON.stringify({ cart_id: id }), "POST"),
        ...withBody(`/api/cart/${id}`, "{}"),
      ],
      { firstPartyOrigins: [ORIGIN] },
    );

    const consumer = model.apis.find((api) => api.url.includes("{"));
    expect(consumer?.depends_on).toHaveLength(1);
    expect(consumer?.depends_on[0]?.kind).toBe("inferred");
  });

  it("names the field, never the value", () => {
    const id = "8f14e45fceea167a5a36dedd4bea2543";
    const model = buildApiModel(
      [
        ...withBody("/api/cart", JSON.stringify({ cart_id: id }), "POST"),
        ...withBody(`/api/cart/${id}`, "{}"),
      ],
      { firstPartyOrigins: [ORIGIN] },
    );
    const bases = model.apis.flatMap((api) => api.depends_on.map((e) => e.basis)).join(" ");

    expect(bases).toContain("cart_id");
    expect(bases).not.toContain(id);
  });

  it("finds no edge between requests that share nothing", () => {
    const model = buildApiModel(
      [...withBody("/api/one", '{"id":"aaaaaaaaaaaaaaaa"}'), ...withBody("/api/two", "{}")],
      { firstPartyOrigins: [ORIGIN] },
    );
    for (const api of model.apis) expect(api.depends_on, api.url).toEqual([]);
  });

  it("does not follow a token, however id-shaped", () => {
    // A token in a later URL is a finding about the application, not a
    // dependency — and following it would mean holding the token in memory
    // to do string comparisons with.
    //
    // The first version of this test used `/api/login`, which the traffic
    // classifier excludes as `auth_infrastructure` before the model is
    // built — so it passed whether or not the token rule existed. Both
    // endpoints here are ordinary application traffic, which is what makes
    // the rule the thing under test.
    // Named `csrfValue`, not `token`: the secret scanner reads any
    // `token = "..."` assignment as a credential, whatever is on the right.
    // Renaming costs nothing and keeps the allowlist from growing — and a
    // fixture that needs an allowlist entry is a fixture that made the
    // allowlist wider than it needed to be.
    const csrfValue = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const model = buildApiModel(
      [
        ...withBody("/api/cart", JSON.stringify({ csrf_token: csrfValue }), "POST"),
        ...withBody(`/api/checkout?csrf=${csrfValue}`, "{}"),
      ],
      { firstPartyOrigins: [ORIGIN] },
    );

    // Precondition: both endpoints reached the model. Without this the
    // assertion below is satisfied by an empty model.
    expect(model.apis.length).toBe(2);
    for (const api of model.apis) expect(api.depends_on, api.url).toEqual([]);
  });

  it("still follows an ordinary identifier in the same shape", () => {
    // The counterweight: the rule above must exclude tokens, not everything
    // that travels in a query string.
    const id = "8f14e45fceea167a5a36dedd4bea2543";
    const model = buildApiModel(
      [
        ...withBody("/api/cart", JSON.stringify({ order_ref: id }), "POST"),
        ...withBody(`/api/checkout?order=${id}`, "{}"),
      ],
      { firstPartyOrigins: [ORIGIN] },
    );
    const edges = model.apis.flatMap((api) => api.depends_on);
    expect(edges).toHaveLength(1);
  });

  it("does not let a value flow backwards", () => {
    // A shared constant would otherwise make two unrelated endpoints
    // mutually dependent.
    const shared = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const model = buildApiModel(
      [
        ...withBody(`/api/first/${shared}`, JSON.stringify({ ref: shared })),
        ...withBody(`/api/second/${shared}`, JSON.stringify({ ref: shared })),
      ],
      { firstPartyOrigins: [ORIGIN] },
    );
    const edges = model.apis.flatMap((api) => api.depends_on);
    // At most one direction, never both.
    expect(edges.length).toBeLessThanOrEqual(1);
  });

  it("ignores values too short to be identifiers", () => {
    const model = buildApiModel(
      [...withBody("/api/status", '{"code":"ok"}'), ...withBody("/api/ok", "{}")],
      { firstPartyOrigins: [ORIGIN] },
    );
    for (const api of model.apis) expect(api.depends_on).toEqual([]);
  });
});
