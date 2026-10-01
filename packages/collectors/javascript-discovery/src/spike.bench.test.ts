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
 *
 * ## There is no memory assertion here, deliberately
 *
 * There was one, bounding RSS growth at 100x the source size. It failed in CI
 * at 106x. Measuring the same parse four times in one process gives +81.5x,
 * +30.3x, **-27.9x** and +26.4x — a parse during which resident memory fell.
 * RSS is a process-wide counter moved by the allocator and the collector
 * independently of the call being measured, and on Linux glibc holds freed
 * pages in its arenas rather than returning them.
 *
 * Switching to `heapUsed` was no better, which is worth recording because it
 * looks like it should be. With 1.5 million AST nodes deliberately retained —
 * a simulated regression to a pure-JS parser, the exact thing such a test
 * exists to catch — three runs reported +82.4 MiB, **-5.7 MiB** and
 * **-3.0 MiB**. A garbage collection inside the measurement window makes the
 * delta negative whatever is being held. The assertion passed with the
 * regression present, which is worse than having no assertion at all.
 *
 * No single-sample delta of either counter can carry this. Making one sound
 * would need forced collection under `--expose-gc` and retained-size rather
 * than delta — a test-runner-wide flag for a property that is already
 * protected elsewhere.
 *
 * What actually bounds memory is §10B.9's maximum-asset-size gate, and that
 * is tested deterministically in `pipeline.test.ts` ("counts what it refused,
 * by reason"). The one-off spike measurement, and why a V8 heap ceiling does
 * not bound a native parser, are recorded in
 * `docs/architecture/js-analysis-spike.md`.
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
      // CPU time, not wall clock. The suite runs several headless Chrome
      // instances alongside this, and a bound on elapsed time measures how
      // busy the machine is: this took 3.6 s alone and 50.5 s in the full
      // run, on the same laptop, on the same commit. That is the flake the
      // module note above predicted and then walked into — "a tight bound
      // would fail on a loaded CI runner and teach everyone to ignore it".
      //
      // What §10B.9 is about is the parser's cost, which is what this now
      // measures. Time spent waiting for a core is not the parser's.
      const analyzer = createTreeSitterAnalyzer();
      const started = process.cpuUsage();
      const result = analyzer.analyze({
        script: "spike.js",
        source: source as string,
        timeBudgetMs: 60_000,
      });
      const spent = process.cpuUsage(started);
      const elapsed = Math.round((spent.user + spent.system) / 1000);

      // It completed rather than erroring or being cut off.
      expect(result.status, result.limitReason).toBe("complete");
      expect(result.bytes).toBeGreaterThanOrEqual(FIVE_MB);

      // Measured at ~730 ms of CPU for 7.3 MiB on a developer machine. Ten
      // seconds is the failure threshold, not the expectation: it catches an
      // order of magnitude, which is what a bad upgrade looks like.
      expect(
        elapsed,
        `${elapsed} ms of CPU for ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`,
      ).toBeLessThan(10_000);

      // And it actually extracted something, rather than walking a tree it
      // could not read. Prettier's bundles carry plenty of path-shaped
      // strings; zero findings would mean the walk is broken.
      expect(result.urls.length + result.routes.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
