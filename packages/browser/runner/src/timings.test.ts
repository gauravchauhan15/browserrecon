import { describe, expect, it } from "vitest";
import { pageTimings } from "./runner.js";

/**
 * How a page's share of the scan's clock (§8.3) is spent.
 *
 * Before this, the two waits were constants: 15s for the document and 2s for
 * the network to go quiet. Both were measurably wrong in both directions —
 * the reference application needed 24.6s to reach `domcontentloaded` cold
 * and headless,
 * and a static fixture does not need two seconds of silence to prove it is
 * idle — and neither had any relationship to how much time the scan had
 * left.
 */
describe("what a page's allowance buys", () => {
  it("spends more on a page when the scan has more to give", async () => {
    const lean = pageTimings(20_000);
    const generous = pageTimings(120_000);
    expect(generous.navigationMs).toBeGreaterThan(lean.navigationMs);
    expect(generous.settleMs).toBeGreaterThan(lean.settleMs);
  });

  it("leaves time over for the harvest and the interactions", async () => {
    // The shares deliberately do not add to 1. A page that spent its whole
    // slice loading would have nothing left for the reads that are the
    // actual point of visiting it.
    const { navigationMs, settleMs } = pageTimings(100_000);
    expect(navigationMs + settleMs).toBeLessThan(100_000);
  });

  it("brackets the navigation wait where peer tools put it", async () => {
    // Playwright defaults to 30s and Katana to 10s, so a floor of 15s and a
    // ceiling of 60s spans what comparable tools consider reasonable.
    // Without the floor a tight budget produces a navigation timeout no real
    // application can meet, and every page reports as failed.
    expect(pageTimings(1_000).navigationMs).toBe(15_000);
    expect(pageTimings(10_000_000).navigationMs).toBe(60_000);
  });

  it("does not wait for quiet longer than a page is worth", async () => {
    // A page that never goes quiet is normal, so the settle is a cap on
    // patience rather than a target. Unbounded, one polling page would eat
    // an arbitrary share of a two-hour budget.
    expect(pageTimings(10_000_000).settleMs).toBe(30_000);
  });

  it("lets an explicit setting win over the pacing", async () => {
    // Pacing is a default, not a policy: someone who knows their target
    // needs 90 seconds should get 90 seconds.
    const timings = pageTimings(20_000, { navigationTimeoutMs: 90_000, settleMs: 45_000 });
    expect(timings.navigationMs).toBe(90_000);
    expect(timings.settleMs).toBe(45_000);
  });

  it("falls back to a usable page rather than none when unpaced", async () => {
    // Direct use and tests call `visit` without an allowance. Treating that
    // as zero time would make every such page fail its navigation.
    const timings = pageTimings(undefined);
    expect(timings.navigationMs).toBeGreaterThanOrEqual(15_000);
    expect(timings.settleMs).toBeGreaterThan(0);
  });
});
