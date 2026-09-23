import { describe, expect, it } from "vitest";
import {
  CONSUMER_FILTERS,
  TRAFFIC_ROLES,
  classifyTraffic,
  passesFilter,
  type ObservationForRole,
} from "./roles.js";

const FIRST_PARTY = ["https://app.test"];
const at = (overrides: Partial<ObservationForRole> = {}): ObservationForRole => ({
  url: "https://app.test/api/orders",
  method: "GET",
  firstPartyOrigins: FIRST_PARTY,
  ...overrides,
});

const roleOf = (overrides: Partial<ObservationForRole> = {}): string =>
  classifyTraffic(at(overrides)).role;

describe("the roles that matter", () => {
  it("calls a first-party API call application_api", async () => {
    expect(roleOf()).toBe("application_api");
  });

  it("separates a first-party asset from an API call", async () => {
    expect(roleOf({ url: "https://app.test/app.css", mimeType: "text/css" })).toBe(
      "application_asset",
    );
  });

  it("recognises analytics by host", async () => {
    expect(roleOf({ url: "https://www.google-analytics.com/collect" })).toBe(
      "analytics_telemetry",
    );
    expect(roleOf({ url: "https://api.segment.io/v1/t" })).toBe("analytics_telemetry");
  });

  it("recognises advertising separately from analytics", async () => {
    expect(roleOf({ url: "https://ads.doubleclick.net/x" })).toBe("advertising_marketing");
  });

  it("recognises a third-party widget", async () => {
    expect(roleOf({ url: "https://widget.intercom.io/x" })).toBe("third_party_widget");
  });

  it("calls a WebSocket control frame a keepalive", async () => {
    expect(roleOf({ isControlFrame: true })).toBe("keepalive");
  });

  it("calls a 304 cache revalidation, whatever else it looks like", async () => {
    // Counting a conditional request as an API call inflates every coverage
    // number.
    expect(roleOf({ status: 304 })).toBe("cache_revalidation");
    expect(roleOf({ conditional: true })).toBe("cache_revalidation");
  });
});

describe("a page is not an endpoint", () => {
  /**
   * The M3 gate found this: a scan of a six-page fixture reported ten APIs,
   * six of which were the HTML pages the crawler had navigated to and one a
   * 404 favicon. Every V3 output inherited it — the surface listed documents
   * as endpoints, coverage counted them as runtime APIs, and workflow
   * segments were padded with page loads, which is what lifted one fixture's
   * confidence above the threshold.
   *
   * The `application_api` signal had read "first-party request with an
   * application payload" from the start. Nothing checked the payload.
   */
  it("does not call a navigated HTML page an API", () => {
    expect(
      roleOf({
        url: "https://app.test/settings",
        resourceType: "Document",
        mimeType: "text/html",
      }),
    ).toBe("application_asset");
  });

  it("does not call a 404 favicon an API", () => {
    // What the browser asks for on its own, with whatever content type the
    // server happened to return.
    expect(
      roleOf({
        url: "https://app.test/favicon.ico",
        resourceType: "Other",
        mimeType: "text/plain",
        status: 404,
      }),
    ).toBe("application_asset");
  });

  it("still calls an HTML fragment fetched by script an API", () => {
    // The counterweight. An HTMX-style partial is an endpoint the
    // application calls, and the content type alone cannot tell it from a
    // page — the resource type can.
    expect(
      roleOf({
        url: "https://app.test/partials/cart",
        resourceType: "Fetch",
        mimeType: "text/html",
      }),
    ).toBe("application_api");
  });

  it("still calls structured data an API however the browser fetched it", () => {
    // `Other` covers more than favicons. A resource type on the list is only
    // decisive when there is no application payload to contradict it.
    expect(
      roleOf({
        url: "https://app.test/api/orders",
        resourceType: "Other",
        mimeType: "application/json",
      }),
    ).toBe("application_api");
    expect(
      roleOf({
        url: "https://app.test/api/orders",
        resourceType: "Other",
        mimeType: "application/vnd.api+json",
      }),
    ).toBe("application_api");
  });

  it("changes nothing when the resource type was not recorded", () => {
    // Telemetry that never saw a resource type must not lose a real API to
    // this rule.
    expect(roleOf({ mimeType: undefined })).toBe("application_api");
  });

  it("files a third-party page on no list as a third-party widget", () => {
    // An unlisted iframe is still somebody else's code running in the page.
    expect(
      roleOf({
        url: "https://widgets.example.com/embed",
        resourceType: "Document",
        mimeType: "text/html",
      }),
    ).toBe("third_party_widget");
  });
});

describe("polling is detected structurally, not by domain", () => {
  // §17A.2. Polling to a first-party API is invisible to any tracker list,
  // and it is the noise most likely to be mistaken for a workflow.
  it("recognises a first-party heartbeat nothing triggered", async () => {
    expect(
      roleOf({
        url: "https://app.test/api/notifications/poll",
        repeatCount: 12,
        repeatIntervalMs: 5_000,
        repeatJitter: 0.02,
        followedInteraction: false,
      }),
    ).toBe("polling_heartbeat");
  });

  it("does not call repeated clicking polling", async () => {
    // A human clicking repeatedly produces wildly uneven gaps; a timer
    // does not.
    expect(
      roleOf({
        repeatCount: 12,
        repeatIntervalMs: 5_000,
        repeatJitter: 0.9,
        followedInteraction: true,
      }),
    ).toBe("application_api");
  });

  it("does not call a request that followed an interaction polling", async () => {
    expect(
      roleOf({
        repeatCount: 12,
        repeatIntervalMs: 5_000,
        repeatJitter: 0.01,
        followedInteraction: true,
      }),
    ).toBe("application_api");
  });

  it("needs more than two repeats before deciding", async () => {
    expect(roleOf({ repeatCount: 2, repeatIntervalMs: 5_000, repeatJitter: 0 })).toBe(
      "application_api",
    );
  });
});

describe("auth infrastructure is not a heartbeat", () => {
  it("files a token refresh as auth even though it repeats on a timer", async () => {
    // Otherwise it is filed as a heartbeat and hidden from the workflow
    // detection §17A.3 explicitly wants it included in.
    expect(
      roleOf({
        url: "https://app.test/oauth/token",
        method: "POST",
        repeatCount: 20,
        repeatIntervalMs: 60_000,
        repeatJitter: 0.01,
      }),
    ).toBe("auth_infrastructure");
  });

  it("recognises the usual auth paths", async () => {
    for (const path of [
      "/login",
      "/logout",
      "/session/refresh",
      "/.well-known/openid-configuration",
    ]) {
      expect(roleOf({ url: `https://app.test${path}` }), path).toBe("auth_infrastructure");
    }
  });
});

describe("the curated list is not relied on alone", () => {
  it("still treats an unknown third-party script as third-party", async () => {
    // A curated list is out of date the day it ships, so the structural
    // fallback has to carry what it misses.
    expect(
      roleOf({
        url: "https://cdn.some-startup-nobody-listed.example/sdk.js",
        mimeType: "application/javascript",
      }),
    ).toBe("third_party_widget");
  });

  it("files an unrecognised third-party request as unknown rather than guessing", async () => {
    expect(roleOf({ url: "https://unknown-host.example/ping" })).toBe("unknown");
  });
});

describe("classify, never drop", () => {
  it("always returns a role from the published set", async () => {
    for (const observation of [
      at(),
      at({ url: "not a url" }),
      at({ url: "https://x.example/", mimeType: "application/octet-stream" }),
      at({ isControlFrame: true }),
    ]) {
      expect(TRAFFIC_ROLES as readonly string[]).toContain(classifyTraffic(observation).role);
    }
  });

  it("records the signal that produced the role", async () => {
    // §17A requires this: a role without its evidence cannot be argued with.
    for (const observation of [
      at(),
      at({ status: 304 }),
      at({ url: "https://segment.io/x" }),
    ]) {
      expect(classifyTraffic(observation).signal.length).toBeGreaterThan(10);
    }
  });
});

describe("per-consumer filters", () => {
  it("gives the event store everything", async () => {
    // §17A.1: the raw event stays whatever its role. "This app talks to
    // fourteen trackers" is itself attack surface.
    for (const role of TRAFFIC_ROLES) {
      expect(passesFilter(role, "event_store"), role).toBe(true);
    }
  });

  it("counts only application API towards coverage", async () => {
    // So a tracker-heavy site does not report inflated coverage.
    expect(CONSUMER_FILTERS.coverage).toEqual(["application_api"]);
    expect(passesFilter("analytics_telemetry", "coverage")).toBe(false);
  });

  it("keeps analytics out of the LLM context budget", async () => {
    expect(passesFilter("analytics_telemetry", "llm_context")).toBe(false);
    expect(passesFilter("application_api", "llm_context")).toBe(true);
  });

  it("includes auth in workflow detection but not in API sequencing", async () => {
    expect(passesFilter("auth_infrastructure", "workflow_detection")).toBe(true);
    expect(passesFilter("auth_infrastructure", "api_sequencing")).toBe(false);
  });

  it("exports everything, grouped rather than filtered", async () => {
    for (const role of TRAFFIC_ROLES) {
      expect(passesFilter(role, "attack_surface_export"), role).toBe(true);
    }
  });
});

describe("an authentication path is not an authentication endpoint", () => {
  it("does not call a vendor's session-replay bundle auth infrastructure", () => {
    // AUTH_PATHS matches a substring, and `session` is in `session-replay.js`.
    // The M3 gate found the noisy fixture reporting a third-party replay
    // script as the application's own auth infrastructure.
    expect(
      roleOf({
        url: "https://app.test/vendor/session-replay.js",
        resourceType: "Script",
        mimeType: "text/javascript",
      }),
    ).toBe("application_asset");
  });

  it("still calls a login page auth infrastructure", () => {
    // The counterweight. `text/html` is not an asset type, so a login screen
    // is unaffected — which matters, because §17A.3 wants the auth flow
    // visible to workflow detection.
    expect(
      roleOf({
        url: "https://app.test/login",
        resourceType: "Document",
        mimeType: "text/html",
      }),
    ).toBe("auth_infrastructure");
  });

  it("still calls a token endpoint auth infrastructure", () => {
    expect(roleOf({ url: "https://app.test/oauth/token", mimeType: "application/json" })).toBe(
      "auth_infrastructure",
    );
  });
});
