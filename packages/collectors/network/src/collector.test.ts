import { describe, expect, it } from "vitest";
import { EventBus } from "@browserrecon/events";
import { collectNetwork } from "./collector.js";

/**
 * Driven by a bus rather than a browser.
 *
 * The collector subscribes rather than being handed events, which is what lets
 * it run against a live scan, a replayed event log, or — here — events
 * published by hand. Integration against real traffic lives in
 * fixture-traffic.test.ts.
 */

const bus = (): EventBus => new EventBus();

const request = async (
  on: EventBus,
  overrides: Partial<{
    requestId: string;
    url: string;
    method: string;
    targetId: string;
    resourceType: string;
    initiator: { type: string; url?: string };
    hasPostData: boolean;
  }> = {},
): Promise<void> => {
  await on.publish({
    type: "network_request",
    provenance: "observed",
    auth_context: "anonymous",
    payload: {
      requestId: "1",
      url: "https://example.com/api/a",
      method: "GET",
      targetId: "page:1",
      initiator: { type: "script" },
      hasPostData: false,
      ...overrides,
    },
  });
};

const response = async (
  on: EventBus,
  overrides: Partial<{
    requestId: string;
    url: string;
    status: number;
    targetId: string;
    mimeType: string;
    body: { text?: string; skipped?: string };
  }> = {},
): Promise<void> => {
  await on.publish({
    type: "network_response",
    provenance: "observed",
    auth_context: "anonymous",
    payload: {
      requestId: "1",
      url: "https://example.com/api/a",
      status: 200,
      targetId: "page:1",
      ...overrides,
    },
  });
};

describe("joining a request to what became of it", () => {
  it("produces one observation, not three events", async () => {
    // Every consumer downstream wants the request, not the pieces it arrived
    // in. Building the join in each of them would mean each getting it subtly
    // differently.
    const on = bus();
    const collector = collectNetwork(on);

    await request(on);
    await response(on, { status: 201, mimeType: "application/json" });
    await on.drain();

    const { observations } = collector.model;
    expect(observations).toHaveLength(1);
    expect(observations[0]?.method).toBe("GET");
    expect(observations[0]?.status).toBe(201);
    expect(observations[0]?.mimeType).toBe("application/json");
  });

  it("keeps request ids from two targets apart", async () => {
    // CDP ids are unique only within a target, so two pages can collide. A
    // model that merged them would attribute one page's response to another
    // page's request.
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { requestId: "7", targetId: "page:1", url: "https://example.com/one" });
    await request(on, { requestId: "7", targetId: "page:2", url: "https://example.com/two" });
    await response(on, {
      requestId: "7",
      targetId: "page:2",
      status: 404,
      url: "https://example.com/two",
    });
    await on.drain();

    const { observations } = collector.model;
    expect(observations).toHaveLength(2);
    expect(observations.find((o) => o.url.path === "/one")?.status).toBeUndefined();
    expect(observations.find((o) => o.url.path === "/two")?.status).toBe(404);
  });

  it("records a failure with a typed reason", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    await request(on);
    await on.publish({
      type: "network_failed",
      provenance: "observed",
      auth_context: "anonymous",
      payload: {
        requestId: "1",
        targetId: "page:1",
        errorText: "net::ERR_CONNECTION_REFUSED",
        canceled: false,
      },
    });
    await on.drain();

    const observation = collector.model.observations[0];
    expect(observation?.failure?.reason).toBe("connection_refused");
    expect(observation?.failure?.raw).toBe("net::ERR_CONNECTION_REFUSED");
  });

  it("ignores a response for a request it never saw start", async () => {
    // Telemetry attaching mid-flight. Inventing a half-observation would put
    // a request in the model that was never observed being made.
    const on = bus();
    const collector = collectNetwork(on);

    await response(on, { requestId: "99" });
    await on.drain();

    expect(collector.model.observations).toHaveLength(0);
  });

  it("counts requests that never finished", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { requestId: "1", url: "https://example.com/done" });
    await response(on, { requestId: "1", url: "https://example.com/done" });
    await request(on, { requestId: "2", url: "https://example.com/hanging" });
    await on.drain();

    expect(collector.model.inFlight).toBe(1);
  });

  it("notices when the response came back from somewhere else", async () => {
    // A redirect the browser followed. Recording it is what lets a later
    // stage notice a request that left the origin it was aimed at.
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { url: "https://example.com/old" });
    await response(on, { url: "https://cdn.other.test/new" });
    await on.drain();

    const observation = collector.model.observations[0];
    expect(observation?.url.path).toBe("/old");
    expect(observation?.respondedFrom?.origin).toBe("https://cdn.other.test");
  });

  it("does not report respondedFrom when nothing moved", async () => {
    const on = bus();
    const collector = collectNetwork(on);
    await request(on);
    await response(on);
    await on.drain();

    expect(collector.model.observations[0]?.respondedFrom).toBeUndefined();
  });
});

describe("grouping by origin", () => {
  it("collapses equivalent URLs into one endpoint but counts both requests", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { requestId: "1", url: "https://example.com/api/a?b=2&a=1" });
    await request(on, { requestId: "2", url: "https://EXAMPLE.com:443/api/a?a=1&b=2" });
    await on.drain();

    const group = collector.model.origins[0];
    expect(collector.model.origins).toHaveLength(1);
    expect(group?.origin).toBe("https://example.com");
    expect(group?.requests).toBe(2);
    // One endpoint, two observations of it.
    expect(group?.endpoints.size).toBe(1);
    expect([...(group?.endpoints.values() ?? [])][0]).toHaveLength(2);
  });

  it("separates origins and sorts them, so output is reproducible", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { requestId: "1", url: "https://zeta.test/a" });
    await request(on, { requestId: "2", url: "https://alpha.test/a" });
    await request(on, { requestId: "3", url: "https://middle.test/a" });
    await on.drain();

    expect(collector.model.origins.map((group) => group.origin)).toEqual([
      "https://alpha.test",
      "https://middle.test",
      "https://zeta.test",
    ]);
  });

  it("summarises the methods and statuses seen, sorted", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { requestId: "1", method: "POST", url: "https://example.com/a" });
    await response(on, { requestId: "1", status: 500, url: "https://example.com/a" });
    await request(on, { requestId: "2", method: "GET", url: "https://example.com/b" });
    await response(on, { requestId: "2", status: 200, url: "https://example.com/b" });
    await on.drain();

    const group = collector.model.origins[0];
    expect(group?.methods).toEqual(["GET", "POST"]);
    expect(group?.statuses).toEqual([200, 500]);
  });

  it("does not count a cancellation as a failure", async () => {
    // Otherwise every scan reports dozens of failures that are just the page
    // navigating away.
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { requestId: "1", url: "https://example.com/a" });
    await on.publish({
      type: "network_failed",
      provenance: "observed",
      auth_context: "anonymous",
      payload: {
        requestId: "1",
        targetId: "page:1",
        errorText: "net::ERR_ABORTED",
        canceled: true,
      },
    });
    await request(on, { requestId: "2", url: "https://example.com/b" });
    await on.publish({
      type: "network_failed",
      provenance: "observed",
      auth_context: "anonymous",
      payload: {
        requestId: "2",
        targetId: "page:1",
        errorText: "net::ERR_CONNECTION_REFUSED",
        canceled: false,
      },
    });
    await on.drain();

    expect(collector.model.origins[0]?.failures).toBe(1);
  });
});

describe("the model as a whole", () => {
  it("keeps observations in request order", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    for (let index = 1; index <= 5; index += 1) {
      await request(on, { requestId: String(index), url: `https://example.com/${index}` });
    }
    await on.drain();

    expect(collector.model.observations.map((o) => o.url.path)).toEqual([
      "/1",
      "/2",
      "/3",
      "/4",
      "/5",
    ]);
    // And carries the envelope sequence, which is the ordering authority.
    const sequences = collector.model.observations.map((o) => o.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("stops consuming once stopped", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    await request(on, { requestId: "1" });
    await on.drain();
    collector.stop();

    await request(on, { requestId: "2", url: "https://example.com/after" });
    await on.drain();

    expect(collector.model.observations).toHaveLength(1);
  });

  it("survives being stopped twice", async () => {
    const collector = collectNetwork(bus());
    collector.stop();
    expect(() => collector.stop()).not.toThrow();
  });

  it("ignores event types it does not own", async () => {
    const on = bus();
    const collector = collectNetwork(on);

    await on.publish({
      type: "page_loaded",
      provenance: "observed",
      auth_context: "anonymous",
      payload: { frameId: "f1", isMainFrame: true, event: "load", targetId: "page:1" },
    });
    await on.drain();

    expect(collector.model.observations).toHaveLength(0);
  });
});
