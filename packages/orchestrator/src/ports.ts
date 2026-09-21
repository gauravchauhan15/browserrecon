/**
 * What the orchestrator needs from the rest of the system — dev plan §1.2,
 * §2 rule 2 (interface first at every external boundary).
 *
 * The orchestrator owns *sequence and failure handling*, not the work. It
 * depends on these interfaces rather than on `puppeteer-core`, katana or a
 * file writer, for one reason that pays for the indirection: BR-M1-28's four
 * required tests are the happy path, the discovery failure, the browser
 * crash and the timeout — and three of those are states a real browser will
 * not enter on demand. A test that cannot reliably produce a browser crash
 * is a test that does not cover the crash path.
 *
 * The real implementations live in `apps/cli`, which is the only place §1.2
 * allows everything to be imported at once.
 */
import type { Candidate } from "@browserrecon/deterministic-explorer";
import type { TokenBucket } from "@browserrecon/rate-controller";

/** Injected so the four failure paths are testable without waiting (§36.1). */
export interface Clock {
  now(): number;
  /** Resolves after `ms`, or when `signal` aborts — never later. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface DiscoveryPort {
  readonly name: string;
  /**
   * Produce candidates, respecting the shared bucket.
   *
   * Yields rather than returns, so browsing can start on the first URL
   * instead of waiting for the crawler to finish (§8.5 rule 2). A crawler
   * that returns an array forces the pipeline to be sequential no matter
   * what the orchestrator does.
   */
  run(context: DiscoveryContext): AsyncIterable<Candidate>;
}

export interface DiscoveryContext {
  readonly target: string;
  /** The one bucket. Discovery and browsing share it (§8.5 rule 2). */
  readonly bucket: TokenBucket;
  /** Aborted when the discovery deadline passes or the scan stops. */
  readonly signal: AbortSignal;
}

export interface BrowsingPort {
  /**
   * Visit one page and collect from it.
   *
   * Throwing is how a browser crash reaches the orchestrator. The
   * distinction that matters is in `BrowsingError.fatal`: a page that failed
   * is one page, a browser that died is every page after it.
   */
  visit(context: VisitContext): Promise<VisitResult>;
  /** Start or restart the browser. Called again after a crash. */
  launch(): Promise<void>;
  close(): Promise<void>;
}

export interface VisitContext {
  readonly candidate: Candidate;
  readonly bucket: TokenBucket;
  readonly signal: AbortSignal;
}

export interface VisitResult {
  /** URLs found on the page, fed straight back into the queue. */
  readonly discovered: readonly Candidate[];
  readonly requests: number;
}

/**
 * A browser-level failure, as opposed to a page-level one.
 *
 * Carried as a class rather than a flag on the result because the
 * orchestrator has to tell them apart in a `catch`, where a result is not
 * available.
 */
export class BrowserCrash extends Error {
  override readonly name = "BrowserCrash";
}

export interface CollectionPort {
  /** Flush and fsync everything collected. */
  finalize(): Promise<void>;
  readonly eventsWritten: number;
}

export interface ExportPort {
  /**
   * Write the artifacts.
   *
   * Runs on partial data by design: a scan that crashed after 40 pages
   * should still produce the report for those 40.
   */
  write(input: ExportInput): Promise<readonly string[]>;
}

export interface ExportInput {
  readonly completeness: "complete" | "partial";
  readonly stopReason?: string | undefined;
  readonly pagesVisited: number;
  readonly candidatesDiscovered: number;
}
