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
