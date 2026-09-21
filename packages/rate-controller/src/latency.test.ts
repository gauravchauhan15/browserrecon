import { describe, expect, it } from "vitest";
import { RATE_PROFILES, createLatencyThrottle } from "./latency.js";

describe("rising latency with no errors at all", () => {
  it("still slows the scan down", async () => {
    // §8.1's core requirement, and the case hard failures miss entirely.
    // Most sites have no rate limiting configured: under load they do not
    // return an error, they just get slower until they fall over. By the
    // time a 5xx arrives the damage is done.
    const throttle = createLatencyThrottle({ profile: "normal", slowStartRequests: 0 });

    // A perfectly healthy server, degrading.
    for (const latency of [50, 60, 80, 120, 200, 400, 800, 1600, 3200]) {
      throttle.observe(latency, true);
    }

    expect(throttle.state.smoothedLatencyMs).toBeGreaterThan(1_000);
    expect(throttle.state.delayMs).toBeGreaterThan(300);
    // Every single response was a 2xx.
    expect(throttle.state.effectiveRate).toBeLessThan(RATE_PROFILES.normal.requestsPerSecond);
  });

  it("speeds back up when the target recovers", async () => {
    const throttle = createLatencyThrottle({ profile: "normal", slowStartRequests: 0 });
    for (let i = 0; i < 10; i += 1) throttle.observe(4_000, true);
    const slow = throttle.state.delayMs;

    for (let i = 0; i < 30; i += 1) throttle.observe(40, true);
    expect(throttle.state.delayMs).toBeLessThan(slow);
  });
});

describe("only a healthy response may lower the delay", () => {
  it("never lets a fast error speed the scan up", async () => {
    // A 500 often comes back fast because the server gave up early. Letting
    // it inform the delay downwards speeds the scan up precisely as the
    // target starts failing.
    const throttle = createLatencyThrottle({ profile: "normal", slowStartRequests: 0 });
    for (let i = 0; i < 10; i += 1) throttle.observe(3_000, true);
    const slow = throttle.state.delayMs;

    for (let i = 0; i < 10; i += 1) throttle.observe(5, false);
    expect(throttle.state.delayMs).toBeGreaterThanOrEqual(slow);
  });

  it("lets a slow error raise the delay", async () => {
    const throttle = createLatencyThrottle({ profile: "normal", slowStartRequests: 0 });
    throttle.observe(50, true);
    const quick = throttle.state.delayMs;
    for (let i = 0; i < 5; i += 1) throttle.observe(8_000, false);
    expect(throttle.state.delayMs).toBeGreaterThan(quick);
  });
});

describe("slow start", () => {
  it("opens below the configured rate and ramps while healthy", async () => {
    // A scan that opens at full rate has already delivered its worst burst
    // before it has any evidence about how the target copes.
    const throttle = createLatencyThrottle({ profile: "normal", slowStartRequests: 10 });
    const opening = throttle.state.delayMs;
    expect(throttle.state.slowStarting).toBe(true);
    expect(opening).toBeGreaterThan(1000 / RATE_PROFILES.normal.requestsPerSecond);

    for (let i = 0; i < 10; i += 1) throttle.observe(50, true);
    expect(throttle.state.slowStarting).toBe(false);
    expect(throttle.state.delayMs).toBeLessThan(opening);
  });

  it("does not ramp past the configured rate during slow start", async () => {
    const throttle = createLatencyThrottle({ profile: "normal", slowStartRequests: 10 });
    for (let i = 0; i < 9; i += 1) throttle.observe(1, true);
    expect(throttle.state.delayMs).toBeGreaterThanOrEqual(
      1000 / RATE_PROFILES.normal.requestsPerSecond,
    );
  });
});

describe("Crawl-delay is a floor", () => {
  it("raises the floor above the profile's own", async () => {
    // The request is the operator's; the profile is only ours.
    const throttle = createLatencyThrottle({ profile: "aggressive", crawlDelaySeconds: 10 });
    expect(throttle.floorMs).toBe(10_000);

    for (let i = 0; i < 50; i += 1) throttle.observe(5, true);
    expect(throttle.state.delayMs).toBeGreaterThanOrEqual(10_000);
  });

  it("never lowers a floor the profile already set", async () => {
    const throttle = createLatencyThrottle({ profile: "polite", crawlDelaySeconds: 0.1 });
    expect(throttle.floorMs).toBe(RATE_PROFILES.polite.minDelayMs);
  });
});

describe("the profiles are coherent", () => {
  it("orders rate, concurrency and floor consistently", async () => {
    // §7.2: each profile's numbers have to agree with each other, so no
    // combination produces a budget that reads as one thing and delivers
    // another.
    const { polite, normal, aggressive } = RATE_PROFILES;
    expect(polite.requestsPerSecond).toBeLessThan(normal.requestsPerSecond);
    expect(normal.requestsPerSecond).toBeLessThan(aggressive.requestsPerSecond);
    expect(polite.targetConcurrency).toBeLessThanOrEqual(normal.targetConcurrency);
    expect(normal.targetConcurrency).toBeLessThanOrEqual(aggressive.targetConcurrency);
    expect(polite.minDelayMs).toBeGreaterThanOrEqual(normal.minDelayMs);
  });

  it("defaults to normal", async () => {
    expect(createLatencyThrottle().floorMs).toBe(RATE_PROFILES.normal.minDelayMs);
  });
});
