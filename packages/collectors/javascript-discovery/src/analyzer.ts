/**
 * The `JSAnalyzer` boundary — build plan §10A.1, §10A.2, §10A.3, §10A.5;
 * dev plan BR-M2-05.
 *
 * §10A.1 is explicit: *do not expose the parser's internal data structures as
 * BrowserRecon's public schema*. Everything below is BrowserRecon's own
 * vocabulary, and nothing in this file imports a parser. That is checkable
 * rather than aspirational — `analyzer.test.ts` asserts no tree-sitter type
 * reaches an exported signature.
 *
 * The reason is not tidiness. The parser is the one dependency most likely to
 * be replaced: jsluice is a Go binary, tree-sitter is a native addon, and a
 * pure-JS parser may win later on a platform where neither installs. A
 * consumer that had learned the parser's node types would have to be rewritten
 * each time.
 *
 * ## Every candidate is a candidate
 *
 * §10A.3 draws the line this whole package sits on: **a JavaScript candidate
 * is not an invoked API.** A string that looks like `/api/orders/{id}` in a
 * bundle might be an endpoint, a log message, a routing table entry for a
 * feature that shipped disabled, or dead code from 2019. Static analysis
 * cannot tell, and pretending otherwise turns a discovery aid into a source
 * of confident wrong answers.
 *
 * So nothing here is ever called "found" or "an endpoint". Everything carries
 * a `source` naming the script and line, and status is settled later by
 * runtime observation (BR-M2-12) — not here.
 */

/** Where in a script something was seen. §10A.3 requires it on every record. */
export interface SourceLocation {
  /** The script's URL, or `inline:<hash>` for a script with none. */
  readonly script: string;
  /** 1-based, as an editor counts. */
  readonly line: number;
  readonly column?: number | undefined;
}

/**
 * Confidence in a static candidate.
 *
 * Three levels, not a number: a score invites arithmetic nobody can justify,
 * and the honest distinction is coarse.
 *
 *   `high`   an unambiguous literal in a request position — the URL argument
 *            of a `fetch` call
 *   `medium` a literal that looks like a path, found somewhere plausible
 *   `low`    assembled from expressions, or found in a position that could be
 *            anything
 */
export type CandidateConfidence = "high" | "medium" | "low";

/** §10A.4's origin classification, as far as static evidence permits. */
export const ORIGIN_KINDS = [
  "first_party",
  "same_site",
  "third_party",
  "api",
  "auth",
  "cdn",
  "payment",
  "analytics",
  "websocket",
  "unknown",
] as const;

export type OriginKind = (typeof ORIGIN_KINDS)[number];

export interface OriginCandidate {
  readonly origin: string;
  readonly kind: OriginKind;
  /** Why this kind, so a reader can disagree with it. */
  readonly basis: string;
  readonly sources: readonly SourceLocation[];
}

export interface UrlCandidate {
  /** Exactly as it appeared in the source. Never rewritten. */
  readonly value: string;
  readonly absolute: boolean;
  readonly confidence: CandidateConfidence;
  readonly sources: readonly SourceLocation[];
}

/**
 * A path that looks like an API endpoint.
 *
 * Separate from `UrlCandidate` because the two answer different questions:
 * every API candidate is a URL candidate, and most URL candidates are not
 * API candidates.
 */
export interface ApiCandidate {
  readonly path: string;
  /** Present only when a method was statically determinable. */
  readonly method?: string | undefined;
  readonly confidence: CandidateConfidence;
  /** Why this was taken for an API rather than a page. */
  readonly basis: string;
  readonly sources: readonly SourceLocation[];
}

/** A client-side route — a screen, not an endpoint. */
export interface RouteCandidate {
  readonly path: string;
  readonly confidence: CandidateConfidence;
  readonly basis: string;
  readonly sources: readonly SourceLocation[];
}

/** §10A.5's request libraries. */
export const REQUEST_LIBRARIES = [
  "fetch",
  "xhr",
  "axios",
  "graphql",
  "websocket",
  "eventsource",
  "beacon",
  "unknown",
] as const;

export type RequestLibrary = (typeof REQUEST_LIBRARIES)[number];

/**
 * A place in the code where a request is built.
 *
 * §10A.5: *do not fabricate values that cannot be resolved statically*. So
 * `urlExpression` is the source text — `` `/api/order/${id}` `` — not a
 * guess at what `id` might be, and `urlLiteral` is set only when the whole
 * thing was a literal. A consumer that needs certainty reads `urlLiteral`;
 * one that wants to see the shape reads the expression.
 */
export interface RequestPattern {
  readonly library: RequestLibrary;
  readonly method?: string | undefined;
  /** The URL argument's source text, verbatim. */
  readonly urlExpression: string;
  /** Set only when the URL was a plain literal with nothing interpolated. */
  readonly urlLiteral?: string | undefined;
  /** The body argument's source text, where there was one. */
  readonly bodyExpression?: string | undefined;
  readonly source: SourceLocation;
}

/** An API base or service URL held in configuration. */
export interface ConfigCandidate {
  readonly key: string;
  /** The literal value, when it was one. */
  readonly value?: string | undefined;
  /** The source text, when it was not. */
  readonly expression?: string | undefined;
  readonly source: SourceLocation;
}

/** Everything one script yielded. */
export interface AnalysisResult {
  readonly script: string;
  readonly origins: readonly OriginCandidate[];
  readonly urls: readonly UrlCandidate[];
  readonly apis: readonly ApiCandidate[];
  readonly routes: readonly RouteCandidate[];
  readonly requests: readonly RequestPattern[];
  readonly config: readonly ConfigCandidate[];
  /**
   * `complete`, or why it is not.
   *
   * §10B.9: a parser failure is an analysis event, not a scan failure. A
   * partial result is kept and labelled rather than discarded — a bundle
   * that was truncated at 2 MB still named every endpoint in the first 2 MB,
   * and throwing that away to report a clean failure helps nobody.
   */
  readonly status: "complete" | "partial" | "failed";
  readonly limitReason?: string | undefined;
  /** Milliseconds spent, for the budget accounting §10B.9 asks for. */
  readonly durationMs: number;
  readonly bytes: number;
}

export interface AnalyzeInput {
  /** The script's URL, or `inline:<hash>`. Used for source locations only. */
  readonly script: string;
  readonly source: string;
  /** The page's origin, for deciding what is first-party. */
  readonly pageOrigin?: string | undefined;
  /** Give up after this long. §10B.9's per-file time budget. */
  readonly timeBudgetMs?: number | undefined;
}

/**
 * The interface §10A.1 specifies.
 *
 * Named in the plan's snake_case; spelled in this codebase's camelCase, which
 * is the only difference. One method per intelligence category so an
 * implementation can be partial — a CLI analyzer that only extracts URLs
 * returns empty arrays from the rest rather than pretending to a capability
 * it lacks.
 */
export interface JSAnalyzer {
  /** Identifies the implementation in reports and in analysis events. */
  readonly name: string;
  /**
   * Bumped when extraction rules change.
   *
   * Part of the analysis cache key (§10B.8, BR-M2-10): a cached result from
   * an older ruleset must not be served after the rules improve, or the
   * improvement never reaches a bundle anyone has already scanned.
   */
  readonly ruleVersion: string;

  analyze(input: AnalyzeInput): AnalysisResult;

  extractOrigins(input: AnalyzeInput): readonly OriginCandidate[];
  extractUrls(input: AnalyzeInput): readonly UrlCandidate[];
  extractApiCandidates(input: AnalyzeInput): readonly ApiCandidate[];
  extractRouteCandidates(input: AnalyzeInput): readonly RouteCandidate[];
  extractRequestPatterns(input: AnalyzeInput): readonly RequestPattern[];
  extractConfigCandidates(input: AnalyzeInput): readonly ConfigCandidate[];

  /**
   * Turn a byte offset into a line and column.
   *
   * §10A.1's `locate_source`. Exposed because initiator chains arrive with
   * offsets and a report needs lines.
   */
  locateSource(source: string, offset: number): { line: number; column: number };
}
