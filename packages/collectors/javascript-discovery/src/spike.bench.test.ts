import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTreeSitterAnalyzer } from "./index.js";

/**
 * The BR-M2-05 spike, as a test that runs on every commit.
 *
 * `docs/architecture/js-analysis-spike.md` records the one-off measurement
 * and the decision. This keeps it honest: a dependency upgrade that made the
 * parser ten times slower, or that broke on a real minified bundle, would
 * otherwise be found by whoever next scanned a large application.
 *
 * The bundle is real minified production JavaScript — Prettier's own plugin
 * bundles, which are already a devDependency and already shipped minified.
 * Resolved through `require.resolve` rather than a path into `node_modules`,
 * because a pnpm store layout is not a stable address.
 *
 * The thresholds are deliberately loose. This asserts "the parser copes with
 * a real bundle at a sane cost", not a benchmark number: a tight bound would
 * fail on a loaded CI runner and teach everyone to ignore it.
 */

const require = createRequire(import.meta.url);

/** Real minified bundles, largest first. */
const BUNDLES = [
  "prettier/plugins/flow.js",
  "prettier/plugins/typescript.js",
  "prettier/plugins/babel.js",
  "prettier/plugins/estree.js",
];

function realMinifiedSource(minimumBytes: number): string | undefined {
  const parts: string[] = [];
  for (const bundle of BUNDLES) {
    try {
      parts.push(readFileSync(require.resolve(bundle), "utf8"));
    } catch {
      // A layout that does not expose it. Better to skip than to assert
      // against a file that is not there.
    }
  }
  if (parts.length === 0) return undefined;

  // Each wrapped in its own IIFE, so the concatenation is valid JavaScript
  // rather than a syntax accident that would measure error recovery instead.
  let source = "";
  while (source.length < minimumBytes) {
    for (const part of parts) source += `(function(){${part}})();\n`;
  }
  return source;
}

const FIVE_MB = 5 * 1024 * 1024;
const source = realMinifiedSource(FIVE_MB);
const spikeTest = source === undefined ? it.skip : it;

describe("BR-M2-05: tree-sitter on a real minified bundle", () => {
  it("has a bundle to measure against", () => {
    // A skipped spike that nobody notices is the failure mode this guards.
    expect(source, "no real minified bundle was resolvable").toBeDefined();
    expect((source ?? "").length).toBeGreaterThanOrEqual(FIVE_MB);
  });

  spikeTest(
    "parses and extracts within §10B.9's bounds",
    () => {
      const analyzer = createTreeSitterAnalyzer();
      const started = Date.now();
      const result = analyzer.analyze({
        script: "spike.js",
        source: source as string,
        timeBudgetMs: 60_000,
      });
      const elapsed = Date.now() - started;

      // It completed rather than erroring or being cut off.
      expect(result.status, result.limitReason).toBe("complete");
      expect(result.bytes).toBeGreaterThanOrEqual(FIVE_MB);

      // Measured at ~730 ms for 7.3 MiB on a developer machine. Ten seconds
      // is the failure threshold, not the expectation: it catches an order
      // of magnitude, which is what a bad upgrade looks like.
      expect(
        elapsed,
        `${elapsed} ms for ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`,
      ).toBeLessThan(10_000);

      // And it actually extracted something, rather than walking a tree it
      // could not read. Prettier's bundles carry plenty of path-shaped
      // strings; zero findings would mean the walk is broken.
      expect(result.urls.length + result.routes.length).toBeGreaterThan(0);
    },
    120_000,
  );

  spikeTest(
    "does not hold memory proportional to nothing",
    () => {
      // The spike measured RSS growing to ~28x the source size, which is the
      // argument for §10B.9's maximum-asset-size cap. This pins the order of
      // magnitude so a regression to, say, 200x is visible.
      const analyzer = createTreeSitterAnalyzer();
      const before = process.memoryUsage().rss;
      const result = analyzer.analyze({
        script: "spike.js",
        source: source as string,
        timeBudgetMs: 60_000,
      });
      const grew = process.memoryUsage().rss - before;

      expect(result.status).toBe("complete");
      expect(
        grew,
        `rss grew ${(grew / 1024 / 1024).toFixed(0)} MiB for ${(result.bytes / 1024 / 1024).toFixed(1)} MiB of source`,
      ).toBeLessThan(result.bytes * 100);
    },
    120_000,
  );
});
