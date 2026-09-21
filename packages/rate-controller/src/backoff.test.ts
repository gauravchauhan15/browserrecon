import { describe, expect, it } from "vitest";
import { createBackoffController, parseRetryAfter } from "./backoff.js";

describe("Retry-After", () => {
  it("honours delta-seconds exactly", async () => {
    expect(parseRetryAfter("120", 0)).toBe(120_000);
  });

  it("honours an HTTP-date", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  });

  it("treats a date in the past as retry-now, not a negative wait", async () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("ignores a value it cannot trust rather than reading it as zero", async () => {
    // A malformed header must not become an instruction to retry
    // immediately — the opposite of what the server asked for.
    for (const value of ["soon", "", "  ", "-5", "1.5.2", undefined]) {
      expect(parseRetryAfter(value, 0), String(value)).toBeUndefined();
    }
  });
});

describe("backing off", () => {
  const fixed = { jitter: (): number => 1, now: (): number => 0 };

  it("honours Retry-After exactly, with no jitter or exponent applied", async () => {
    const controller = createBackoffController(fixed);
    expect(controller.trigger("http_429", "30").delayMs).toBe(30_000);
  });

  it("escalates on repeated triggers", async () => {
    const controller = createBackoffController({ ...fixed, config: { baseDelayMs: 1_000 } });
    expect(controller.trigger("http_429").delayMs).toBe(1_000);
    expect(controller.trigger("http_429").delayMs).toBe(2_000);
    expect(controller.trigger("http_429").delayMs).toBe(4_000);
  });

  it("reduces concurrency as well as rate", async () => {
    // A target struggling under ten concurrent connections is not helped by
    // the same ten arriving more slowly.
    const controller = createBackoffController({
      ...fixed,
      config: { startingConcurrency: 8, minConcurrency: 1 },
    });
    expect(controller.trigger("http_429").concurrency).toBe(4);
    expect(controller.trigger("http_429").concurrency).toBe(2);
    expect(controller.trigger("http_429").concurrency).toBe(1);
    expect(controller.trigger("http_429").concurrency).toBe(1);
  });

  it("caps the delay rather than waiting forever", async () => {
    const controller = createBackoffController({ ...fixed, config: { maxDelayMs: 5_000 } });
    for (let i = 0; i < 20; i += 1) controller.trigger("http_5xx");
    expect(controller.state.delayMs).toBe(5_000);
  });

  it("applies jitter, so components do not retry in a synchronised wave", async () => {
    const controller = createBackoffController({
      now: () => 0,
      jitter: () => 0.5,
      config: { baseDelayMs: 1_000 },
    });
    expect(controller.trigger("http_429").delayMs).toBe(500);
  });
});

describe("recovery is gradual", () => {
  it("does not clear backoff after a single success", async () => {
    // Returning to full speed at once re-triggers whatever we just backed
    // off from, which is worse for the target than not backing off.
    const controller = createBackoffController({
      now: () => 0,
      jitter: () => 1,
      config: { recoveryThreshold: 5, baseDelayMs: 1_000 },
    });
    controller.trigger("http_429");
    controller.trigger("http_429");
    const before = controller.state.delayMs;

    controller.healthy();
    expect(controller.state.delayMs).toBe(before);
  });

  it("eases only after a run of healthy responses", async () => {
    const controller = createBackoffController({
      now: () => 0,
      jitter: () => 1,
      config: { recoveryThreshold: 3, baseDelayMs: 1_000 },
    });
    controller.trigger("http_429");
    controller.trigger("http_429");
    expect(controller.state.delayMs).toBe(2_000);

    controller.healthy();
    controller.healthy();
    controller.healthy();
    expect(controller.state.delayMs).toBe(1_000);
  });

  it("clears once the trigger count reaches zero", async () => {
    const controller = createBackoffController({
      now: () => 0,
      jitter: () => 1,
      config: { recoveryThreshold: 1 },
    });
    controller.trigger("http_429");
    controller.healthy();
    expect(controller.state.delayMs).toBe(0);
    expect(controller.waitMs()).toBe(0);
  });

  it("resets the healthy run when a trigger interrupts it", async () => {
    const controller = createBackoffController({
      now: () => 0,
      jitter: () => 1,
      config: { recoveryThreshold: 3, baseDelayMs: 1_000 },
    });
    controller.trigger("http_429");
    controller.healthy();
    controller.healthy();
    controller.trigger("http_429");
    controller.healthy();
    // Two healthy responses before the trigger do not count towards the
    // three needed after it.
    expect(controller.state.consecutive).toBe(2);
  });
});

describe("state outlives the phase", () => {
  it("is still in effect when a later phase asks", async () => {
    // §8.5 rule 5: backoff triggered while the crawler was running has to
    // still apply when the browser starts. It is the same target, and it
    // asked once.
    let clock = 0;
    const controller = createBackoffController({
      now: () => clock,
      jitter: () => 1,
      config: { baseDelayMs: 10_000 },
    });

    controller.trigger("http_429"); // during discovery
    clock = 3_000; // browsing begins
    expect(controller.waitMs()).toBe(7_000);
  });
});
