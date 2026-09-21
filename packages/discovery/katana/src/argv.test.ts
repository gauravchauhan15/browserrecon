import { describe, expect, it } from "vitest";
import { buildKatanaArgv, rateFromArgv, type KatanaLimits } from "./argv.js";

const limits = (overrides: Partial<KatanaLimits> = {}): KatanaLimits => ({
  maxRequestsPerSecond: 5,
  maxConcurrency: 2,
  maxRuntimeMinutes: 30,
  maxDepth: 3,
  ...overrides,
});

const argv = (overrides: Partial<Parameters<typeof buildKatanaArgv>[0]> = {}) =>
  buildKatanaArgv({
    target: "https://app.test",
    limits: limits(),
    allowedOrigins: ["https://app.test"],
    ...overrides,
  });

describe("rate flags come from the policy", () => {
  // Katana's own default is 150 requests per second. `polite` is 2. Getting
  // this wrong means a user who asked for a careful scan gets one
  // seventy-five times heavier than they agreed to.
  it("derives the request rate from the policy, not from a default", async () => {
    expect(rateFromArgv(argv({ limits: limits({ maxRequestsPerSecond: 2 }) }))).toBe(2);
    expect(rateFromArgv(argv({ limits: limits({ maxRequestsPerSecond: 20 }) }))).toBe(20);
  });

  it("never emits Katana's default rate when the policy is polite", async () => {
    const built = argv({ limits: limits({ maxRequestsPerSecond: 2 }) });
    expect(built).not.toContain("150");
    expect(built.join(" ")).toContain("-rl 2");
  });

  it("derives concurrency and depth from the policy too", async () => {
    const built = argv({ limits: limits({ maxConcurrency: 4, maxDepth: 7 }) });
    expect(built.join(" ")).toContain("-c 4");
    expect(built.join(" ")).toContain("-d 7");
  });

  it("pins parallel hosts to one, so the rate is not multiplied", async () => {
    // The policy's rate is per target. Letting Katana spread across hosts
    // would silently multiply it by the number of hosts.
    expect(argv().join(" ")).toContain("-p 1");
  });

  it("bounds the crawl by the scan's own time budget", async () => {
    expect(argv({ limits: limits({ maxRuntimeMinutes: 12 }) }).join(" ")).toContain("-ct 12m");
  });

  it("never emits a rate below one, whatever the policy says", async () => {
    // A fractional rate would round to zero and Katana would refuse to run;
    // the scan should proceed slowly rather than not at all.
    expect(rateFromArgv(argv({ limits: limits({ maxRequestsPerSecond: 0.5 }) }))).toBe(1);
  });
});

describe("scope", () => {
  it("anchors the host pattern, so a crawl cannot wander", async () => {
    // Unanchored, `app.test` also matches `notapp.test.evil`.
    const built = argv({ allowedOrigins: ["https://app.test"] });
    const index = built.indexOf("-cs");
    expect(built[index + 1]).toBe("^https?://app\\.test(/|$)");
  });

  it("emits one scope pattern per allowed origin", async () => {
    const built = argv({ allowedOrigins: ["https://a.test", "https://b.test"] });
    expect(built.filter((entry) => entry === "-cs")).toHaveLength(2);
  });

  it("drops a malformed origin rather than passing it through", async () => {
    // A pattern built from garbage could be unanchored and widen scope.
    const built = argv({ allowedOrigins: ["not a url", "https://ok.test"] });
    expect(built.filter((entry) => entry === "-cs")).toHaveLength(1);
  });

  it("escapes regex characters in a host", async () => {
    const built = argv({ allowedOrigins: ["https://a.b.test"] });
    expect(built.join(" ")).toContain("a\\.b\\.test");
  });
});
