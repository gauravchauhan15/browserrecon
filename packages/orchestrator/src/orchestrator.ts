/**
 * The scan lifecycle — build plan §9.3, §8.5 rules 2 and 3, §6;
 * dev plan BR-M1-28.
 *
 * policy → discovery ‖ browsing → collection → export.
 *
 * ## The overlap, and what bounds it
 *
 * §8.5 rule 2 permits discovery and browsing to overlap. The reason is
 * simple arithmetic: a crawler and a browser run in sequence take the sum of
 * their times, and a polite scan spends most of its life waiting for tokens
 * anyway. They overlap around **one** bucket, which is the part that makes
 * it safe — two phases with two buckets is two scans' worth of traffic
 * arriving at a target that agreed to one.
 *
 * What bounds the overlap is the discovery deadline. Browsing does not wait
 * for the crawler to finish; when the deadline passes, whatever candidates
 * arrived are what the scan has, prioritisation is finalised, and the fact
 * is recorded. A crawler that hangs must not hang the scan — "finalizes
 * prioritization without stalling the scan" is the acceptance criterion, and
 * the failure it prevents is a scan that produces nothing because a
 * subprocess never exited.
 *
 * ## Failure isolation
 *
 * Every phase after `policy` is isolated (see `phases.ts`). The shape is
 * always the same: record what went wrong, mark the scan `partial`, and
 * carry on with less. Export runs even when browsing crashed, because forty
 * pages of report is worth more than an error message.
 */
import {
  createBudgetTracker,
  type Candidate,
  type VisitQueue,
} from "@browserrecon/deterministic-explorer";
import type { TokenBucket } from "@browserrecon/rate-controller";
import {
  completenessFromPhases,
  isFatal,
  primaryDegradation,
  type PhaseName,
  type PhaseOutcome,
  type PhaseStatus,
} from "./phases.js";
import type {
  BrowsingPort,
  Clock,
  CollectionPort,
  DiscoveryPort,
  ExportPort,
} from "./ports.js";
import { BrowserCrash } from "./ports.js";

export interface ScanLimits {
  readonly maxPages: number;
  readonly maxRuntimeMinutes: number;
  readonly maxFailedActions: number;
  /** Hard bound on the discovery phase, independent of the scan budget. */
  readonly discoveryTimeoutMs: number;
  /**
   * How long a discovery source gets to stop after being asked.
   *
   * The deadline aborts the signal; a well-behaved source notices and
   * returns. One that does not — a subprocess wrapper that never wired the
   * signal through, which is an easy thing to get wrong — would otherwise
   * hang the scan at the join, after every page had already been visited.
   */
  readonly discoveryStopGraceMs?: number | undefined;
  /**
   * How many times a dead browser may be relaunched.
   *
   * Bounded because a browser that crashes on every page will crash on the
   * next one too, and an unbounded retry turns a broken target into a scan
   * that never ends.
   */
  readonly maxRelaunches: number;
}

/** What to change, per reason the seed was refused. */
const REMEDY_FOR_REFUSAL: Readonly<Record<string, string>> = {
  out_of_scope: "Pass --allowed-origins with the origin you mean to scan.",
  policy_denied:
    "A policy rule refused the target. `--no-deny-loopback` allows 127.0.0.1 for a local development server; --excluded-paths controls the rest.",
  not_http: "Targets must be http(s) URLs.",
};

/** A source that has not stopped in this long is not going to. */
const DISCOVERY_STOP_GRACE_MS = 5_000;

export interface ScanInput {
  readonly target: string;
  readonly limits: ScanLimits;
  readonly bucket: TokenBucket;
  readonly queue: VisitQueue;
  /** Tried in order. A failure falls through to the next (§8.5 rule 3). */
  readonly discovery: readonly DiscoveryPort[];
  readonly browsing: BrowsingPort;
  readonly collection: CollectionPort;
  readonly export: ExportPort;
  readonly clock: Clock;
  /** Called after every phase, so `session.json` survives a kill (§30). */
  readonly onPhase?: ((outcomes: readonly PhaseOutcome[]) => void) | undefined;
  /** External cancellation — ^C, or a supervising process. */
  readonly signal?: AbortSignal | undefined;
}

export interface ScanResult {
  readonly completeness: "complete" | "partial";
  readonly stopReason: string;
  readonly phases: readonly PhaseOutcome[];
  readonly pagesVisited: number;
  readonly candidatesDiscovered: number;
  readonly artifacts: readonly string[];
  /** Queued URLs the browser did not load, with why. */
  readonly notVisited: readonly {
    readonly url: string;
    readonly outcome: "denied" | "failed";
    readonly detail?: string | undefined;
  }[];
  /** The earliest thing that went wrong, for the summary's one-line reason. */
  readonly degradedBy?: PhaseOutcome | undefined;
}

/** Thrown only for a fatal phase. Every other failure is isolated. */
export class ScanRefused extends Error {
  override readonly name = "ScanRefused";
  constructor(
    message: string,
    readonly outcome: PhaseOutcome,
  ) {
    super(message);
  }
}

export async function runScan(input: ScanInput): Promise<ScanResult> {
  const outcomes: PhaseOutcome[] = [];
  const clock = input.clock;

  const record = (
    phase: PhaseName,
    status: PhaseStatus,
    startedAt: string,
    detail?: string,
    remedy?: string,
  ): PhaseOutcome => {
    const outcome: PhaseOutcome = {
      phase,
      status,
      startedAt,
      finishedAt: new Date(clock.now()).toISOString(),
      ...(detail === undefined ? {} : { detail }),
      ...(remedy === undefined ? {} : { remedy }),
    };
    outcomes.push(outcome);
    // Persisted after every phase, not at the end: a scan killed mid-run is
    // exactly the case `resume` exists for.
    input.onPhase?.(outcomes);
    if (status === "failed" && isFatal(phase)) {
      throw new ScanRefused(detail ?? `${phase} failed`, outcome);
    }
    return outcome;
  };

  // ---- policy -------------------------------------------------------------
  // First, and fatal. §32.10: the boundary is settled before anything
  // touches the network on the user's behalf. The caller resolves the policy
  // and hands us a queue that already refuses out-of-scope URLs; what this
  // phase asserts is that it actually did.
  const policyStarted = new Date(clock.now()).toISOString();
  const seedRefusal = input.queue.offer({ url: input.target, source: "seed", depth: 0 });
  if (seedRefusal !== undefined) {
    record(
      "policy",
      "failed",
      policyStarted,
      // The queue's own reason, not a guess. A refusal that says "check
      // --allowed-origins" when the cause was a loopback address sends the
      // user to the wrong setting, which is worse than saying nothing.
      `the target ${input.target} is refused by its own policy: ${seedRefusal.detail ?? seedRefusal.reason}`,
      REMEDY_FOR_REFUSAL[seedRefusal.reason] ??
        "Check the Target Policy with `browserrecon config validate <url>`; the scan would have visited nothing.",
    );
  }
  record("policy", "ok", policyStarted);

  const tracker = createBudgetTracker({
    budget: {
      maxPages: input.limits.maxPages,
      maxRuntimeMinutes: input.limits.maxRuntimeMinutes,
      maxFailedActions: input.limits.maxFailedActions,
      requestsPerSecond: 1,
      requestsPerPage: 1,
    },
    now: () => clock.now(),
  });

  const scanAbort = new AbortController();
  input.signal?.addEventListener("abort", () => scanAbort.abort(), { once: true });

  // ---- discovery (overlapping) --------------------------------------------
  const discoveryStarted = new Date(clock.now()).toISOString();
  let discovered = 0;
  const discoveryAbort = new AbortController();
  scanAbort.signal.addEventListener("abort", () => discoveryAbort.abort(), { once: true });

  // The deadline is the bound on the overlap. It fires whatever the crawler
  // is doing, because a subprocess that never exits must not decide when the
  // scan ends.
  const deadline = clock
    .sleep(input.limits.discoveryTimeoutMs, discoveryAbort.signal)
    .then(() => {
      discoveryAbort.abort();
    });

  const discoveryFailures: string[] = [];
  const discoveryTask = (async (): Promise<PhaseStatus> => {
    for (const [index, source] of input.discovery.entries()) {
      try {
        for await (const candidate of source.run({
          target: input.target,
          bucket: input.bucket,
          signal: discoveryAbort.signal,
        })) {
          if (discoveryAbort.signal.aborted) break;
          // Offered as they arrive, so browsing can start on the first one.
          input.queue.offer(candidate);
          discovered += 1;
        }
        // A source that produced nothing is not a failure — an empty
        // sitemap is a fact about the target, not about the tool.
        return index === 0 ? "ok" : "degraded";
      } catch (error) {
        discoveryFailures.push(`${source.name}: ${(error as Error).message}`);
        // §8.5 rule 3: fall through to the next source rather than giving
        // up. The scan continues browser-native if every crawler dies.
      }
    }
    return discoveryFailures.length === 0 ? "ok" : "failed";
  })();

  // ---- browsing (overlapping) ---------------------------------------------
  const browsingStarted = new Date(clock.now()).toISOString();
  let relaunches = 0;
  let browsingDetail: string | undefined;
  /** Queued URLs the browser did not load, with why. */
  const notVisited: { url: string; outcome: "denied" | "failed"; detail?: string }[] = [];
  let stopReason = "queue_empty";

  try {
    await input.browsing.launch();
  } catch (error) {
    browsingDetail = `the browser could not be launched: ${(error as Error).message}`;
  }

  if (browsingDetail === undefined) {
    let waitedForDiscovery = false;

    for (;;) {
      if (scanAbort.signal.aborted) {
        stopReason = "cancelled";
        break;
      }

      const timeUp = tracker.check();
      if (timeUp !== undefined) {
        stopReason = timeUp;
        break;
      }

      const candidate = input.queue.take();
      if (candidate === undefined) {
        // An empty queue while discovery is still running is not an empty
        // queue. Waiting once — bounded by the same deadline — is what lets
        // a slow crawler still contribute, without letting it stall the run.
        if (!waitedForDiscovery && !discoveryAbort.signal.aborted) {
          waitedForDiscovery = true;
          await Promise.race([deadline, discoveryTask]);
          continue;
        }
        stopReason = "queue_empty";
        break;
      }

      try {
        const result = await input.browsing.visit({
          candidate,
          bucket: input.bucket,
          signal: scanAbort.signal,
          allowanceMs: tracker.pageAllowanceMs(),
        });
        input.queue.markVisited(candidate.url);
        for (const found of result.discovered) input.queue.offer(found);

        if (result.outcome !== "visited") {
          // A page the browser never loaded is not a page visited. Counting
          // it would let a scan that reached nothing report full coverage of
          // everything it queued.
          notVisited.push({
            url: candidate.url,
            outcome: result.outcome,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          });
          if (result.outcome === "failed") {
            const give = tracker.actionFailed();
            if (give !== undefined) {
              stopReason = give;
              browsingDetail = `${input.limits.maxFailedActions} actions failed in a row`;
              break;
            }
          }
          continue;
        }

        tracker.actionSucceeded();
      } catch (error) {
        if (error instanceof BrowserCrash) {
          // Bounded relaunch. The page is deliberately not retried: a page
          // that killed the browser once will kill it again, and burning
          // every relaunch on one URL costs the rest of the scan.
          input.queue.markVisited(candidate.url);
          if (relaunches >= input.limits.maxRelaunches) {
            browsingDetail =
              `the browser crashed ${relaunches + 1} times; ` +
              `exported ${tracker.pagesVisited} page(s) collected before that`;
            stopReason = "browser_unrecoverable";
            break;
          }
          relaunches += 1;
          try {
            await input.browsing.launch();
          } catch (relaunchError) {
            browsingDetail = `the browser could not be relaunched: ${(relaunchError as Error).message}`;
            stopReason = "browser_unrecoverable";
            break;
          }
          continue;
        }

        // An ordinary page failure. One page, not the scan.
        input.queue.markVisited(candidate.url);
        const give = tracker.actionFailed();
        if (give !== undefined) {
          stopReason = give;
          browsingDetail = `${input.limits.maxFailedActions} actions failed in a row`;
          break;
        }
        continue;
      }

      const exhausted = tracker.pageVisited();
      if (exhausted !== undefined) {
        stopReason = exhausted;
        break;
      }
    }
  } else {
    stopReason = "browser_unrecoverable";
  }

  discoveryAbort.abort();

  // Joining discovery is itself bounded. Awaiting it outright would mean a
  // source that ignores its signal hangs the scan here — after every page
  // has been visited and with every artifact still unwritten, which is the
  // worst possible moment to hang.
  const ABANDONED = Symbol("discovery did not stop");
  const joined = await Promise.race([
    discoveryTask.catch(() => "failed" as PhaseStatus),
    clock
      .sleep(input.limits.discoveryStopGraceMs ?? DISCOVERY_STOP_GRACE_MS)
      .then(() => ABANDONED),
  ]);

  const abandoned = joined === ABANDONED;
  const discoveryStatus: PhaseStatus = abandoned ? "degraded" : (joined as PhaseStatus);
  const discoveryDetails = [
    ...discoveryFailures,
    ...(abandoned ? ["a discovery source did not stop when the deadline passed"] : []),
  ];
  void deadline;

  record(
    "discovery",
    discoveryStatus,
    discoveryStarted,
    discoveryDetails.length === 0 ? undefined : discoveryDetails.join("; "),
    discoveryDetails.length === 0
      ? undefined
      : "Discovery fell back to browser-native crawling; run `browserrecon doctor` to check the crawler.",
  );

  // Every queued URL refused is a scan that did nothing, however cleanly it
  // did it. Measured in the M1 gate: without this the run reported
  // "complete · 1 of 1 discovered" for a site the browser never opened.
  const everyPageRefused =
    tracker.pagesVisited === 0 && notVisited.length > 0 && browsingDetail === undefined;
  if (everyPageRefused) {
    const first = notVisited[0];
    browsingDetail =
      `no page was loaded: all ${notVisited.length} queued URL(s) were ${first?.outcome ?? "refused"}` +
      (first?.detail === undefined ? "" : ` (${first.detail})`);
  }

  const browsingDegraded = notVisited.length > 0 || relaunches > 0;
  record(
    "browsing",
    browsingDetail === undefined ? (browsingDegraded ? "degraded" : "ok") : "failed",
    browsingStarted,
    browsingDetail ??
      (browsingDegraded
        ? [
            ...(relaunches > 0 ? [`the browser was relaunched ${relaunches} time(s)`] : []),
            ...(notVisited.length > 0
              ? [`${notVisited.length} queued URL(s) were not loaded`]
              : []),
          ].join("; ")
        : undefined),
    browsingDetail === undefined
      ? undefined
      : everyPageRefused
        ? "No page was loaded. Check the Target Policy: --allowed-origins, --no-deny-loopback (for a local server) and --excluded-paths all decide what may be visited."
        : "Re-run, or resume this session once the target is stable.",
  );

  try {
    await input.browsing.close();
  } catch {
    // A browser that will not close is already gone. The profile sweeper
    // handles the leftovers; failing the scan here would discard data that
    // is already on disk.
  }

  // ---- collection ---------------------------------------------------------
  const collectionStarted = new Date(clock.now()).toISOString();
  try {
    await input.collection.finalize();
    record("collection", "ok", collectionStarted);
  } catch (error) {
    record(
      "collection",
      "failed",
      collectionStarted,
      `the event log could not be finalized: ${(error as Error).message}`,
      "The events already written are still readable; check disk space and permissions.",
    );
  }

  // ---- export -------------------------------------------------------------
  // Runs whatever happened above. A scan that crashed after forty pages
  // should still produce the report for those forty.
  const exportStarted = new Date(clock.now()).toISOString();
  const completenessSoFar = completenessFromPhases(outcomes);
  let artifacts: readonly string[] = [];
  try {
    artifacts = await input.export.write({
      completeness:
        completenessSoFar === "complete" && stopReason === "queue_empty"
          ? "complete"
          : "partial",
      stopReason: stopReason === "queue_empty" ? undefined : stopReason,
      pagesVisited: tracker.pagesVisited,
      candidatesDiscovered: discovered + input.queue.visited.length,
    });
    record("export", "ok", exportStarted);
  } catch (error) {
    record(
      "export",
      "failed",
      exportStarted,
      `the export failed: ${(error as Error).message}`,
      "The raw event log is intact; re-run `browserrecon export <session>`.",
    );
  }

  const completeness = completenessFromPhases(outcomes);
  return {
    completeness:
      completeness === "complete" && stopReason === "queue_empty" ? "complete" : "partial",
    stopReason,
    phases: outcomes,
    pagesVisited: tracker.pagesVisited,
    candidatesDiscovered: discovered + input.queue.visited.length,
    artifacts,
    notVisited,
    degradedBy: primaryDegradation(outcomes),
  };
}

export type { Candidate };
