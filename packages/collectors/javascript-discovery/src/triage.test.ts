import { describe, expect, it } from "vitest";
import {
  PRIORITIES,
  basePriority,
  cacheKey,
  createAnalysisCache,
  hashContent,
  orderForAnalysis,
  triage,
  type AssetFacts,
} from "./index.js";

const asset = (over: Partial<AssetFacts> = {}): AssetFacts => ({
  url: "https://shop.example.com/app.js",
  origin: "https://shop.example.com",
  firstParty: true,
  executed: true,
  bytes: 50_000,
  ...over,
});

describe("base priority (§10B.3)", () => {
  it("puts first-party executed application code first", () => {
    expect(basePriority(asset()).priority).toBe("P0");
  });

  it("puts a first-party lazy chunk just behind it", () => {
    expect(basePriority(asset({ lazy: true })).priority).toBe("P1");
    expect(
      basePriority(asset({ url: "https://shop.example.com/route-admin.js" })).priority,
    ).toBe("P1");
    expect(
      basePriority(asset({ url: "https://shop.example.com/main.8fd21abc.js" })).priority,
    ).toBe("P1");
  });

  it("demotes first-party code that never ran, without discarding it", () => {
    // Still the application's own code, and its strings are still evidence —
    // just behind code that actually executed.
    expect(basePriority(asset({ executed: false })).priority).toBe("P1");
  });

  it("puts same-site shared code at P2 and other third parties at P3", () => {
    expect(
      basePriority(
        asset({ firstParty: false, sameSite: true, url: "https://cdn.shop.example.com/x.js" }),
      ).priority,
    ).toBe("P2");
    expect(
      basePriority(asset({ firstParty: false, url: "https://widget.other.net/x.js" })).priority,
    ).toBe("P3");
  });

  it("puts recognised vendor libraries last", () => {
    for (const url of [
      "https://cdn.net/jquery-3.6.0.min.js",
      "https://cdn.net/lodash.min.js",
      "https://cdn.net/chart.js",
    ]) {
      expect(basePriority(asset({ firstParty: false, url })).priority, url).toBe("P4");
    }
  });

  it("states a basis for every verdict", () => {
    expect(basePriority(asset()).basis.length).toBeGreaterThan(10);
  });
});

describe("runtime evidence overrides naming (§10B.7)", () => {
  it("lifts a third-party script that initiates API traffic", () => {
    // A vendor-looking file that turns out to drive the application's API is
    // more interesting than a first-party file that did nothing.
    const verdict = triage(asset({ firstParty: false, url: "https://cdn.net/vendor.min.js" }), {
      initiatedRequests: 4,
    });
    expect(verdict.basePriority).toBe("P3");
    expect(verdict.priority).toBe("P0");
    expect(verdict.elevatedBy).toContain("initiated API traffic");
  });

  it("lifts a script that registered WebMCP tools", () => {
    const verdict = triage(asset({ firstParty: false }), { registeredWebMcpTools: 2 });
    expect(verdict.priority).toBe("P0");
  });

  it("records what raised it, so a report can explain the order", () => {
    const verdict = triage(asset({ firstParty: false, sameSite: true }), {
      inInitiatorChain: true,
      participatedInNavigation: true,
    });
    expect(verdict.elevatedBy).toHaveLength(2);
    expect(verdict.priority).not.toBe(verdict.basePriority);
  });

  it("leaves an asset alone when the runtime showed nothing", () => {
    const verdict = triage(asset({ firstParty: false }));
    expect(verdict.priority).toBe(verdict.basePriority);
    expect(verdict.elevatedBy).toEqual([]);
  });

  it("never lifts past the top band", () => {
    const verdict = triage(asset(), {
      initiatedRequests: 9,
      registeredWebMcpTools: 9,
      inInitiatorChain: true,
    });
    expect(PRIORITIES).toContain(verdict.priority);
    expect(verdict.priority).toBe("P0");
  });
});

describe("what is not analysed at all", () => {
  it("refuses an asset past the size cap, naming the reason", () => {
    // The spike measured resident memory reaching ~28x the source. Refusing
    // here costs one candidate list; letting it through risks the process.
    const verdict = triage(asset({ bytes: 20_000_000 }), {}, 8 * 1024 * 1024);
    expect(verdict.skip).toContain("size_limit");
  });

  it("skips content already analysed", () => {
    expect(triage(asset({ alreadyAnalysed: true })).skip).toContain("already analysed");
  });

  it("drops skipped assets from the analysis order", () => {
    const verdicts = [
      triage(asset({ url: "a.js" })),
      triage(asset({ url: "b.js", alreadyAnalysed: true })),
    ];
    expect(orderForAnalysis(verdicts).map((v) => v.url)).toEqual(["a.js"]);
  });
});

describe("analysis order", () => {
  it("runs higher priority first", () => {
    const verdicts = [
      triage(asset({ url: "third.js", firstParty: false })),
      triage(asset({ url: "first.js" })),
      triage(asset({ url: "vendor-jquery.min.js", firstParty: false })),
    ];
    expect(orderForAnalysis(verdicts).map((v) => v.url)).toEqual([
      "first.js",
      "third.js",
      "vendor-jquery.min.js",
    ]);
  });

  it("runs the cheaper of two equals first", () => {
    // Under a total time budget, finishing the small one first is strictly
    // more findings for the same seconds.
    const verdicts = [triage(asset({ url: "big.js" })), triage(asset({ url: "small.js" }))];
    const sizes = new Map([
      ["big.js", 900_000],
      ["small.js", 4_000],
    ]);
    expect(orderForAnalysis(verdicts, sizes).map((v) => v.url)).toEqual(["small.js", "big.js"]);
  });

  it("is reproducible when everything else ties", () => {
    const verdicts = [triage(asset({ url: "z.js" })), triage(asset({ url: "a.js" }))];
    expect(orderForAnalysis(verdicts).map((v) => v.url)).toEqual(["a.js", "z.js"]);
  });
});

describe("content dedup (§10B.5)", () => {
  it("records every URL one piece of content was served from", () => {
    // A vendor chunk's reach is what makes it interesting; collapsing the
    // sightings along with the analysis would lose it.
    const cache = createAnalysisCache();
    const hash = hashContent("console.log(1)");

    cache.see(hash, {
      url: "https://a.example.com/v.js",
      origin: "https://a.example.com",
      page: "/one",
      bytes: 14,
    });
    cache.see(hash, {
      url: "https://b.example.com/v.js",
      origin: "https://b.example.com",
      page: "/two",
      bytes: 14,
    });
    const record = cache.see(hash, {
      url: "https://a.example.com/v.js?bust=1",
      origin: "https://a.example.com",
      page: "/one",
      bytes: 14,
    });

    expect(record.allSeenUrls).toHaveLength(3);
    expect(record.origins).toHaveLength(2);
    expect(record.pagesLoadedFrom).toEqual(["/one", "/two"]);
    expect(record.firstSeenUrl).toBe("https://a.example.com/v.js");
  });

  it("counts the duplicate sightings, which is the saving", () => {
    const cache = createAnalysisCache();
    const hash = hashContent("x");
    for (let n = 0; n < 40; n += 1) {
      cache.see(hash, {
        url: `https://x.example.com/p${n}/v.js`,
        origin: "https://x.example.com",
        bytes: 1,
      });
    }
    expect(cache.stats.distinctContent).toBe(1);
    expect(cache.stats.duplicateSightings).toBe(39);
  });

  it("caps the URLs it remembers per content", () => {
    const cache = createAnalysisCache();
    const hash = hashContent("y");
    for (let n = 0; n < 500; n += 1) {
      cache.see(hash, {
        url: `https://x.example.com/p${n}.js`,
        origin: "https://x.example.com",
        bytes: 1,
      });
    }
    expect(cache.records()[0]?.allSeenUrls.length).toBeLessThanOrEqual(50);
  });

  it("hashes content the same way twice and differently for different content", () => {
    expect(hashContent("a")).toBe(hashContent("a"));
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

describe("the analysis cache key (§10B.8)", () => {
  const result = {
    script: "v.js",
    origins: [],
    urls: [],
    apis: [],
    routes: [],
    requests: [],
    config: [],
    status: "complete" as const,
    durationMs: 1,
    bytes: 1,
  };

  it("serves a hit for identical content and identical rules", () => {
    const cache = createAnalysisCache();
    const parts = { contentHash: "abc", parserVersion: "1", ruleVersion: "1.0.0" };
    cache.put(parts, result);
    expect(cache.get(parts)).toBe(result);
    expect(cache.stats.hits).toBe(1);
  });

  it("misses when the extraction rules changed", () => {
    // Keying on content alone means an improved rule never reaches a bundle
    // anyone has already scanned — invisible exactly where there is history
    // to compare against.
    const cache = createAnalysisCache();
    cache.put({ contentHash: "abc", parserVersion: "1", ruleVersion: "1.0.0" }, result);
    expect(
      cache.get({ contentHash: "abc", parserVersion: "1", ruleVersion: "1.1.0" }),
    ).toBeUndefined();
  });

  it("misses when the parser changed", () => {
    const cache = createAnalysisCache();
    cache.put({ contentHash: "abc", parserVersion: "1", ruleVersion: "1.0.0" }, result);
    expect(
      cache.get({ contentHash: "abc", parserVersion: "2", ruleVersion: "1.0.0" }),
    ).toBeUndefined();
  });

  it("misses when a source map appeared", () => {
    const cache = createAnalysisCache();
    const base = { contentHash: "abc", parserVersion: "1", ruleVersion: "1.0.0" };
    cache.put(base, result);
    expect(cache.get({ ...base, sourceMapHash: "map1" })).toBeUndefined();
  });

  it("builds a key from every part", () => {
    expect(cacheKey({ contentHash: "a", parserVersion: "b", ruleVersion: "c" })).toBe(
      "a|b|c|-",
    );
    expect(
      cacheKey({ contentHash: "a", parserVersion: "b", ruleVersion: "c", sourceMapHash: "d" }),
    ).toBe("a|b|c|d");
  });

  it("evicts least recently used, not first inserted", () => {
    // A vendor chunk hit on every page should not be the first thing dropped.
    const cache = createAnalysisCache({ maxEntries: 2 });
    const key = (n: string) => ({ contentHash: n, parserVersion: "1", ruleVersion: "1" });
    cache.put(key("a"), result);
    cache.put(key("b"), result);
    cache.get(key("a"));
    cache.put(key("c"), result);

    expect(cache.get(key("a"))).toBeDefined();
    expect(cache.get(key("b"))).toBeUndefined();
  });

  it("records the analysis status against the content", () => {
    const cache = createAnalysisCache();
    cache.see("abc", { url: "v.js", origin: "https://x.example.com", bytes: 1 });
    cache.put(
      { contentHash: "abc", parserVersion: "1", ruleVersion: "2.0.0" },
      { ...result, status: "partial" },
    );

    expect(cache.records()[0]?.analysisStatus).toBe("partial");
    expect(cache.records()[0]?.analysisVersion).toBe("2.0.0");
  });
});
