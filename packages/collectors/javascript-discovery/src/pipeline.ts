/**
 * Bounded analysis — build plan §10B.4, §10B.9, §10.7; dev plan BR-M2-09.
 *
 * §10B.9: *a parser failure produces an analysis event, not a scan failure.*
 * The scan has already spent minutes driving a browser; losing it because one
 * bundle was pathological would be the worst possible trade.
 *
 * ## The size gate is the memory bound
 *
 * §10B.9 asks for bounded workers so an enormous bundle cannot take down the
 * scan. A worker was built, measured, and removed — see
 * `docs/architecture/js-analysis-spike.md`. Two measurements killed it:
 *
 *   **It did not bound the parser.** tree-sitter allocates its syntax tree in
 *   native memory, not the V8 heap. A worker with a 16 MB old-generation
 *   ceiling parsed a 4.8 MB bundle to completion while resident memory grew
 *   342 MB and the JS heap grew 0.0 MB. V8's limit never saw it.
 *
 *   **Hitting the ceiling was not clean.** Worker threads share the process
 *   address space. Under a pooled test runner, a nested worker reaching its
 *   ceiling reliably took the host process with it — which is the failure the
 *   worker existed to prevent, reproduced by the worker.
 *
 * So §10B.9's *intent* is met by three bounds that were measured to work,
 * rather than by the mechanism it suggested:
 *
 *   **Size**, checked before anything is parsed. The only thing that actually
 *   bounds memory: the spike measured RSS at roughly 28x the source, so the
 *   cap on input is the cap on memory. Refusing an oversized asset costs one
 *   candidate list.
 *
 *   **Time**, checked inside the walk, so a pathological bundle yields what
 *   it found and stops.
 *
 *   **A parser that does not throw.** tree-sitter returns a partial tree for
 *   malformed input rather than raising, and the analyzer catches what is
 *   left. That is the "malformed bundle" half of §10B.9, and it is tested.
 *
 * ## Nothing here throws
 *
 * Every path returns a result carrying its own limit reason. A caller that
 * has to remember to catch is a caller that will forget, and what it forgets
 * is one bundle ending a scan that had already succeeded.
 */
import type { AnalysisResult, AnalyzeInput, JSAnalyzer } from "./analyzer.js";

/** §10B.4's vocabulary, exactly. */
export const LIMIT_REASONS = [
  "parser_timeout",
  "memory_limit",
  "unsupported_syntax",
  "size_limit",
  "total_budget",
  "cancelled",
] as const;

export type LimitReason = (typeof LIMIT_REASONS)[number];

export interface AnalysisBounds {
  /** Assets larger than this are never parsed. */
  readonly maxAssetBytes?: number | undefined;
  /** Per-file wall clock. */
  readonly timeBudgetMs?: number | undefined;
  /** Whole-scan wall clock across every asset. §10B.9's total. */
  readonly totalBudgetMs?: number | undefined;
}

/**
 * Defaults sized from the spike.
 *
 * 8 MB is the load-bearing one: at the measured ~28x ratio that is roughly
 * 230 MB of resident memory for the largest permitted asset, which is a cost
 * a scan can absorb. It also covers every real first-party bundle measured.
 *
 * 10 s per file is about fourteen times the 727 ms a 7.3 MiB bundle took —
 * slack for a loaded machine, not a target. 512 MB of JS heap is generous for
 * the string and the result; it is not a bound on the parser.
 */
type ResolvedBounds = {
  readonly [K in keyof AnalysisBounds]-?: NonNullable<AnalysisBounds[K]>;
};

export const DEFAULT_BOUNDS: ResolvedBounds = {
  maxAssetBytes: 8 * 1024 * 1024,
  timeBudgetMs: 10_000,
  totalBudgetMs: 120_000,
};

export interface BoundedResult {
  readonly result: AnalysisResult;
  /** Set when a bound stopped this asset, so a caller need not parse the reason. */
  readonly bounded?: LimitReason | undefined;
}

/** A result for an asset that was never parsed, so the reason survives. */
export function refusedResult(
  input: Pick<AnalyzeInput, "script" | "source">,
  reason: LimitReason,
  detail: string,
): AnalysisResult {
  return {
    script: input.script,
    origins: [],
    urls: [],
    apis: [],
    routes: [],
    requests: [],
    config: [],
    // Not `partial`: nothing was analysed, and calling it partial would
    // suggest the findings are a subset rather than absent.
    status: "failed",
    limitReason: `${reason}: ${detail}`,
    durationMs: 0,
    bytes: Buffer.byteLength(input.source),
  };
}

export interface PipelineOptions {
  readonly analyzer: JSAnalyzer;
  readonly bounds?: AnalysisBounds | undefined;
  /** Injected so the total-budget path is testable without waiting. */
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AnalysisPipeline {
  analyze(input: AnalyzeInput): Promise<BoundedResult>;
  /** Milliseconds spent so far, against the total budget. */
  readonly elapsedMs: number;
  /** Assets a bound refused, by reason. Reported, never silent (§45). */
  readonly refused: Readonly<Record<string, number>>;
}

/**
 * Run analyses under §10B.9's bounds.
 *
 * Every path returns a result. There is no throw: a caller that has to
 * remember to catch is a caller that will forget, and the failure it forgets
 * is one bundle taking down a scan that had already succeeded.
 */
export function createAnalysisPipeline(options: PipelineOptions): AnalysisPipeline {
  // Spread then re-default: `{...DEFAULT_BOUNDS, ...options.bounds}` puts an
  // explicit `undefined` back over a default, which is how a caller passing
  // one optional field silently loses every other bound.
  const given = options.bounds ?? {};
  const bounds: ResolvedBounds = {
    maxAssetBytes: given.maxAssetBytes ?? DEFAULT_BOUNDS.maxAssetBytes,
    timeBudgetMs: given.timeBudgetMs ?? DEFAULT_BOUNDS.timeBudgetMs,
    totalBudgetMs: given.totalBudgetMs ?? DEFAULT_BOUNDS.totalBudgetMs,
  };
  const now = options.now ?? ((): number => Date.now());
  const started = now();

  const refused: Record<string, number> = {};
  const refuse = (input: AnalyzeInput, reason: LimitReason, detail: string): BoundedResult => {
    refused[reason] = (refused[reason] ?? 0) + 1;
    return { result: refusedResult(input, reason, detail), bounded: reason };
  };

  return {
    get elapsedMs() {
      return now() - started;
    },
    get refused() {
      return { ...refused };
    },

    async analyze(input) {
      if (options.signal?.aborted === true) {
        return refuse(input, "cancelled", "the scan was cancelled");
      }

      const bytes = Buffer.byteLength(input.source);
      if (bytes > bounds.maxAssetBytes) {
        // The gate that actually bounds memory, before any parser sees it.
        return refuse(
          input,
          "size_limit",
          `${bytes} bytes exceeds the ${bounds.maxAssetBytes}-byte cap`,
        );
      }

      if (now() - started > bounds.totalBudgetMs) {
        return refuse(
          input,
          "total_budget",
          `the ${bounds.totalBudgetMs} ms whole-scan analysis budget is spent`,
        );
      }

      const withBudget: AnalyzeInput = {
        ...input,
        timeBudgetMs: input.timeBudgetMs ?? bounds.timeBudgetMs,
      };

      return { result: options.analyzer.analyze(withBudget) };
    },
  };
}
