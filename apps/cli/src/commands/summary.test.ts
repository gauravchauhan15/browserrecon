import { UNREDACTED_OUTPUT_WARNING } from "@browserrecon/core";
import { describe, expect, it } from "vitest";
import { COVERAGE_CAVEAT } from "@browserrecon/coverage";
import {
  TERMINAL_WIDTH,
  formatSummary,
  renderSummary,
  resolveSummaryMode,
  summaryAsJson,
  type ScanSummary,
} from "./summary.js";

function summary(overrides: Partial<ScanSummary> = {}): ScanSummary {
  return {
    target: "https://shop.example.com",
    sessionId: "sess_0001",
    durationSeconds: 184,
    completeness: "complete",
    pagesVisited: 24,
    candidatesDiscovered: 61,
    templatesSaturated: 0,
    instancesSkipped: 0,
    workflows: 3,
    apisObserved: 18,
    apisUnobserved: 0,
    origins: 4,
    jsAssets: 11,
    barriers: [],
    topGaps: [],
    discoverySources: ["browser", "katana"],
    aiMode: "off",
    rateProfile: "normal",
    artifacts: [".output/report.md", ".output/attack-surface.json"],
    outputDir: ".output/sess_0001",
    ...overrides,
  };
}

describe("eighty columns", () => {
  it("never wraps, even with long values", () => {
    // Not nostalgia: a split pane, an SSH session, a CI log viewer. Wrapping
    // destroys an aligned table, and an unreadable summary is the same as no
    // summary.
    const text = renderSummary(
      summary({
        target: `https://${"very-long-subdomain.".repeat(6)}example.com/deep/path`,
        artifacts: [`.output/${"nested/".repeat(15)}report.md`],
        topGaps: [{ reason: "x".repeat(90), count: 3 }],
      }),
    );
    for (const line of text.split("\n")) {
      expect(line.length, `too long: ${line}`).toBeLessThanOrEqual(TERMINAL_WIDTH);
    }
  });

  it("truncates rather than wrapping a long value", () => {
    const text = renderSummary(summary({ rateProfile: "p".repeat(200) }));
    expect(text).toContain("…");
  });
});

describe("what the summary answers", () => {
  it("leads with the target and whether the scan finished", () => {
    const text = renderSummary(summary({ completeness: "partial", stopReason: "max_pages" }));
    expect(text).toContain("shop.example.com");
    expect(text).toContain("partial");
    expect(text).toContain("max_pages");
  });

  it("reports pages visited against candidates discovered", () => {
    // The single most useful number: "24 pages" alone cannot be judged.
    expect(renderSummary(summary())).toContain("24 of 61 discovered");
  });

  it("separates APIs observed from APIs merely discovered", () => {
    const text = renderSummary(summary({ apisObserved: 18, apisUnobserved: 7 }));
    expect(text).toContain("18 observed, 7 discovered but not reached");
  });

  it("makes the tier self-evident without naming tiers", () => {
    // §35A.2: nobody should have to learn what "Tier 2" means to read this.
    // Naming the discovery sources and the AI mode says the same thing in
    // terms a user recognises.
    const tier0 = renderSummary(summary({ discoverySources: [], aiMode: "off" }));
    expect(tier0).toContain("browser-native only");

    const tier2 = renderSummary(
      summary({ discoverySources: ["browser", "katana"], aiMode: "local:qwen" }),
    );
    expect(tier2).toContain("katana");
    expect(tier2).toContain("local:qwen");
  });
});

describe("what it refuses to claim", () => {
  /**
   * The caveat is wrapped to the terminal width, so it is never one line.
   * Asserting on the rendered text directly tests the wrapper; collapsing
   * whitespace first tests the sentence, which is the thing §10C.6 is about.
   */
  const unwrapped = (text: string): string => text.replace(/\s+/g, " ");

  it("prints the coverage package's caveat, not a paraphrase of it", () => {
    // One promise, worded once. A user reads the terminal and then opens
    // report.md; meeting two sentences there makes "do these mean different
    // things?" a question they have to answer themselves.
    expect(unwrapped(renderSummary(summary()))).toContain(unwrapped(COVERAGE_CAVEAT));
  });

  it("never claims complete coverage", () => {
    // §10C.6. This holds even for a scan that finished cleanly, which is
    // exactly the case where the claim is tempting.
    const text = unwrapped(renderSummary(summary({ completeness: "complete" })));
    expect(text).toMatch(/not a claim of complete application coverage/i);
    expect(text).not.toMatch(/full coverage|all endpoints/i);
  });

  it("puts the caveat last, where it is read", () => {
    const text = unwrapped(renderSummary(summary()));
    expect(unwrapped(text).indexOf("not a claim of complete")).toBeGreaterThan(
      unwrapped(text).indexOf("Artifacts"),
    );
  });

  it("shows why coverage stopped where it did", () => {
    // §10C.7: what the scan could *not* do is visible without opening a file.
    const text = renderSummary(
      summary({
        topGaps: [
          { reason: "auth_required", count: 14 },
          { reason: "excluded_by_policy", count: 6 },
        ],
      }),
    );
    expect(text).toContain("Why coverage stopped where it did");
    expect(text).toContain("auth_required");
  });

  it("keeps the gap list short enough to read", () => {
    const text = renderSummary(
      summary({
        topGaps: Array.from({ length: 20 }, (_, index) => ({ reason: `r${index}`, count: 1 })),
      }),
    );
    expect(text).not.toContain("r09");
  });

  it("says no barrier was bypassed whenever barriers are reported", () => {
    // §7.3, in the place a user reads first.
    const text = renderSummary(summary({ barriers: [{ category: "auth_wall", count: 2 }] }));
    expect(text).toContain("auth_wall");
    expect(text).toContain("None was bypassed.");
  });

  it("reports skipped instances rather than silently dropping them", () => {
    // §45's no-silent-loss rule. Saturation is a legitimate optimisation
    // only if the user can see it happened.
    const text = renderSummary(summary({ templatesSaturated: 5, instancesSkipped: 212 }));
    expect(text).toContain("212 instances skipped");
  });

  it("omits the saturation line when nothing was saturated", () => {
    // The common path stays quiet, or users learn to skim past the block.
    expect(renderSummary(summary())).not.toContain("saturated");
  });
});

describe("the next step", () => {
  it("suggests a crawler when discovery was browser-only and thin", () => {
    const text = renderSummary(
      summary({ discoverySources: ["browser"], candidatesDiscovered: 12, pagesVisited: 12 }),
    );
    expect(text).toContain("Next:");
    expect(text).toMatch(/katana|--import-urls/);
  });

  it("suggests resuming when the budget cut the scan short", () => {
    const text = renderSummary(summary({ completeness: "partial", stopReason: "max_runtime" }));
    expect(text).toContain("browserrecon resume sess_0001");
  });

  it("offers exactly one suggestion", () => {
    // A list of four suggestions is a list nobody acts on.
    const text = renderSummary(
      summary({
        discoverySources: ["browser"],
        candidatesDiscovered: 3,
        aiMode: "off",
        completeness: "partial",
      }),
    );
    expect(text.match(/Next:/g) ?? []).toHaveLength(1);
  });

  it("stays silent when there is nothing worth suggesting", () => {
    // Advice on a scan that already did everything is noise. This is the
    // fully-equipped case: a crawler ran, AI was on, the budget held, and
    // every discovered endpoint was reached.
    const text = renderSummary(
      summary({
        discoverySources: ["browser", "katana"],
        aiMode: "local:qwen",
        apisUnobserved: 0,
      }),
    );
    expect(text).not.toContain("Next:");
  });

  it("suggests AI on a clean scan that found workflows but could not name them", () => {
    const text = renderSummary(summary({ aiMode: "off", workflows: 3 }));
    expect(text).toContain("--ai");
  });
});

describe("the unredacted warning", () => {
  it("names the directory that holds raw data", () => {
    const text = renderSummary(summary({ outputDir: ".output/sess_0001" }));
    expect(text).toContain(".output/sess_0001");
    expect(text).toMatch(/UNREDACTED/);
    expect(text).toMatch(/do not commit/i);
  });

  it("agrees with the canonical warning about what is at stake", () => {
    // The wording is shorter here for the 80-column budget, but it must not
    // be weaker than the one the docs and the report carry.
    expect(UNREDACTED_OUTPUT_WARNING).toMatch(/UNREDACTED/);
    expect(renderSummary(summary())).toMatch(/UNREDACTED/);
  });
});

describe("--json", () => {
  it("round-trips every field", () => {
    const input = summary({ topGaps: [{ reason: "auth_required", count: 14 }] });
    expect(JSON.parse(summaryAsJson(input))).toEqual(input);
  });

  it("is parseable without the decorative output", () => {
    const json = summaryAsJson(summary());
    expect(json).not.toContain("━");
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("choosing a mode", () => {
  it("prints the human summary by default", () => {
    expect(resolveSummaryMode({})).toBe("human");
    expect(formatSummary(summary(), "human")).toContain("BrowserRecon");
  });

  it("prints JSON for --json", () => {
    expect(resolveSummaryMode({ json: true })).toBe("json");
    expect(() => JSON.parse(formatSummary(summary(), "json") as string)).not.toThrow();
  });

  it("prints nothing at all for --quiet", () => {
    // Not an empty string: a caller that writes whatever this returns must
    // not put a blank line on a pipeline's stdout.
    expect(resolveSummaryMode({ quiet: true })).toBe("quiet");
    expect(formatSummary(summary(), "quiet")).toBeUndefined();
  });

  it("lets --quiet win over --json", () => {
    // A pipeline that asked for silence and got two kilobytes of JSON is
    // broken; the reverse is a missing convenience.
    expect(resolveSummaryMode({ quiet: true, json: true })).toBe("quiet");
  });
});

describe("the suggestion fits the reason coverage stopped", () => {
  it("suggests authenticating, not crawling, when a login is the wall", () => {
    // A scan that saw one page because everything is behind a login is not
    // short of URLs. The empty-scan golden baseline caught this exact case
    // recommending a crawler.
    const text = renderSummary(
      summary({
        pagesVisited: 1,
        candidatesDiscovered: 1,
        discoverySources: ["browser"],
        topGaps: [{ reason: "auth_required", count: 12 }],
      }),
    );
    expect(text).toContain("authentication");
    expect(text).not.toContain("Install a crawler");
  });

  it("still suggests a crawler when discovery, not auth, is the limit", () => {
    const text = renderSummary(
      summary({
        discoverySources: ["browser"],
        candidatesDiscovered: 9,
        topGaps: [{ reason: "no_links_found", count: 1 }],
      }),
    );
    expect(text).toContain("Install a crawler");
  });
});

describe("wording", () => {
  it("does not fall back to (s) plurals", () => {
    // The summary is the product's face for a first-time user; "1 target(s)"
    // reads as unfinished.
    for (const count of [1, 2]) {
      const text = renderSummary(summary({ topGaps: [{ reason: "auth_required", count }] }));
      expect(text).not.toContain("(s)");
    }
    expect(
      renderSummary(summary({ topGaps: [{ reason: "auth_required", count: 1 }] })),
    ).toContain("1 target needed");
    expect(
      renderSummary(summary({ topGaps: [{ reason: "auth_required", count: 4 }] })),
    ).toContain("4 targets needed");
  });
});
