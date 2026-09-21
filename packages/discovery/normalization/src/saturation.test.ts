import { describe, expect, it } from "vitest";
import {
  buildSignature,
  createSaturationTracker,
  describeDivergence,
  signaturesMatch,
} from "./saturation.js";

const sig = (overrides: Partial<Parameters<typeof buildSignature>[0]> = {}) =>
  buildSignature({
    apiPaths: ["/api/order"],
    statuses: [200],
    formCount: 1,
    linkCount: 12,
    hasTable: true,
    authContext: "anonymous",
    ...overrides,
  });

describe("a uniform template saturates", () => {
  it("stops after N instances and counts what it skipped", async () => {
    // §45's no-silent-loss rule: "3 of 47,218 visited" is an honest
    // sentence; a report showing three orders is not.
    const tracker = createSaturationTracker({
      instancesPerTemplate: 3,
      divergenceSampleCap: 10,
    });
    tracker.register("https://a.test/order/{id}", 47_218);

    for (let i = 0; i < 3; i += 1) tracker.recordVisit("https://a.test/order/{id}", sig());
    const progress = tracker.progress()[0];

    expect(progress?.state).toBe("saturated");
    expect(progress?.visited).toBe(3);
    expect(progress?.skipped).toBe(47_215);
    expect(progress?.summary).toBe("3 of 47218 visited, 47215 skipped as template-equivalent");
    expect(tracker.shouldVisit("https://a.test/order/{id}")).toBe(false);
  });

  it("keeps sampling until it has enough", async () => {
    const tracker = createSaturationTracker({
      instancesPerTemplate: 3,
      divergenceSampleCap: 10,
    });
    tracker.register("https://a.test/p/{id}", 100);
    tracker.recordVisit("https://a.test/p/{id}", sig());
    expect(tracker.shouldVisit("https://a.test/p/{id}")).toBe(true);
    expect(tracker.progress()[0]?.state).toBe("sampling");
  });
});

describe("a divergent template does NOT saturate", () => {
  // The key test of the story. Saturating past an instance that behaves
  // differently is not a saving — that instance is exactly what a security
  // tool exists to find.
  it("keeps sampling when an instance calls a different API", async () => {
    const tracker = createSaturationTracker({
      instancesPerTemplate: 3,
      divergenceSampleCap: 10,
    });
    tracker.register("https://a.test/order/{id}", 500);

    tracker.recordVisit("https://a.test/order/{id}", sig());
    tracker.recordVisit("https://a.test/order/{id}", sig());
    tracker.recordVisit(
      "https://a.test/order/{id}",
      sig({ apiPaths: ["/api/order", "/api/admin/refund"] }),
    );

    const progress = tracker.progress()[0];
    expect(progress?.state).toBe("diverged");
    // Would have saturated at three. Does not.
    expect(tracker.shouldVisit("https://a.test/order/{id}")).toBe(true);
    expect(progress?.skipped).toBe(0);
    expect(progress?.divergenceReasons?.[0]).toContain("/api/admin/refund");
  });

  it("treats a different status as divergence", async () => {
    // One order returns 200 and another 403: an access-control difference,
    // and the most interesting thing a template can do.
    const tracker = createSaturationTracker({
      instancesPerTemplate: 2,
      divergenceSampleCap: 10,
    });
    tracker.recordVisit("t", sig({ statuses: [200] }));
    tracker.recordVisit("t", sig({ statuses: [403] }));
    expect(tracker.progress()[0]?.state).toBe("diverged");
  });

  it("treats a different auth context as divergence", async () => {
    const tracker = createSaturationTracker({
      instancesPerTemplate: 2,
      divergenceSampleCap: 10,
    });
    tracker.recordVisit("t", sig({ authContext: "anonymous" }));
    tracker.recordVisit("t", sig({ authContext: "user:alice" }));
    expect(tracker.progress()[0]?.divergenceReasons?.[0]).toContain("auth contexts");
  });

  it("still stops eventually, at the divergence cap", async () => {
    // Divergence raises the ceiling; it does not remove it. A template where
    // every instance differs would otherwise consume the whole scan.
    const tracker = createSaturationTracker({
      instancesPerTemplate: 2,
      divergenceSampleCap: 5,
    });
    for (let i = 0; i < 5; i += 1) tracker.recordVisit("t", sig({ apiPaths: [`/api/${i}`] }));
    expect(tracker.shouldVisit("t")).toBe(false);
    expect(tracker.progress()[0]?.state).toBe("saturated");
  });

  it("compares against the first instance, so A/B/A/B does not flap", async () => {
    const tracker = createSaturationTracker({
      instancesPerTemplate: 10,
      divergenceSampleCap: 20,
    });
    tracker.recordVisit("t", sig({ apiPaths: ["/a"] }));
    tracker.recordVisit("t", sig({ apiPaths: ["/b"] }));
    tracker.recordVisit("t", sig({ apiPaths: ["/a"] }));
    expect(tracker.progress()[0]?.state).toBe("diverged");
  });
});

describe("signatures", () => {
  it("ignores differences that are not behaviour", async () => {
    // Two product pages differ in text and image URLs; that is not
    // divergence. Comparing anything finer would make every instance
    // divergent and saturation would never fire.
    expect(signaturesMatch(sig({ linkCount: 12 }), sig({ linkCount: 15 }))).toBe(true);
  });

  it("notices a link count in a different order of magnitude", async () => {
    expect(signaturesMatch(sig({ linkCount: 3 }), sig({ linkCount: 300 }))).toBe(false);
  });

  it("notices an extra form, which is a different capability", async () => {
    expect(signaturesMatch(sig({ formCount: 1 }), sig({ formCount: 2 }))).toBe(false);
  });

  it("is order-independent for API paths", async () => {
    expect(
      signaturesMatch(sig({ apiPaths: ["/a", "/b"] }), sig({ apiPaths: ["/b", "/a"] })),
    ).toBe(true);
  });

  it("explains a divergence in words a report can print", async () => {
    const reasons = describeDivergence(sig(), sig({ apiPaths: ["/api/order", "/api/secret"] }));
    expect(reasons.join(" ")).toContain("/api/secret");
  });
});
