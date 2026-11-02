/**
 * Reading the bundles the scan captured — build plan §10A, §10B; dev plan
 * BR-M2-05, BR-M2-09, BR-M2-12.
 *
 * ## Why this exists at all
 *
 * `@browserrecon/collector-javascript-discovery` has had a tree-sitter
 * analyzer, a triage ranking, a bounded pipeline and a static↔runtime
 * reconciler since M2, with tests for each. Nothing imported any of it. A
 * scan of the reference application captured 110 first-party bundles, reported them all as
 * `body captured`, and listed one static API candidate — which was not a
 * candidate at all but a page the budget had cut off, borrowed from the
 * queue's skip list to fill the column.
 *
 * So the parser existed and the report had a place to put its findings, and
 * no line of code connected the two. This is that line.
 *
 * ## It runs after the scan, from the log
 *
 * Not during, and not from the browser. §1.2 again: the bodies are already in
 * `events.jsonl`, so analysis is a pure function of the log and re-runnable
 * against last week's scan with better rules. Running it inside the visit
 * loop would put a parser on the critical path of a rate-limited crawl for no
 * gain.
 *
 * ## Every candidate is still a candidate
 *
 * §10A.3. Nothing here decides an endpoint exists. It produces strings found
 * in code, with the file and line they were found at, and hands them to the
 * reconciler — which is the only thing allowed to say whether the scan ever
 * called one.
 */
import {
  createAnalysisPipeline,
  createTreeSitterAnalyzer,
  orderForAnalysis,
  triage,
  type ApiCandidate,
  type AssetFacts,
} from "@browserrecon/collector-javascript-discovery";
import type { EventEnvelope } from "@browserrecon/events";

/** One script, with the text the scan captured for it. */
interface CapturedScript {
  readonly url: string;
  readonly source: string;
  readonly firstParty: boolean;
  readonly sameSite: boolean;
}

export interface StaticAnalysisResult {
  /** Endpoints named in code, deduplicated across bundles. */
  readonly candidates: readonly ApiCandidate[];
  /** API bases the bundles configured, for the reconciler's prefix match. */
  readonly basePaths: readonly string[];
  /** Scripts whose bodies were parsed. */
  readonly analysed: number;
  /** Scripts captured but not parsed, and why. §45: never silent. */
  readonly skipped: Readonly<Record<string, number>>;
  /** Scripts the parser could not finish. */
  readonly partial: number;
  readonly durationMs: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Last two labels, matching how `roles.ts` decides the same question. */
function site(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/**
 * Pair requests with responses and keep the scripts that arrived with a body.
 *
 * Deduplicated by URL rather than by content hash: two URLs serving identical
 * bytes are one analysis to the pipeline's cache, and the URL is what a
 * source location has to name for a reader to go and look.
 */
function capturedScripts(
  events: readonly EventEnvelope[],
  firstPartyOrigins: readonly string[],
): readonly CapturedScript[] {
  const pending = new Map<string, { url: string; script: boolean }>();
  const scripts = new Map<string, CapturedScript>();
  const sites = new Set(firstPartyOrigins.map((origin) => site(hostOf(origin))));

  for (const envelope of events) {
    if (envelope.type === "network_request") {
      const payload = envelope.payload as {
        requestId?: string;
        url?: string;
        resourceType?: string;
      };
      if (payload.requestId === undefined || payload.url === undefined) continue;
      pending.set(payload.requestId, {
        url: payload.url,
        script: payload.resourceType?.toLowerCase() === "script",
      });
      continue;
    }

    if (envelope.type !== "network_response") continue;
    const payload = envelope.payload as {
      requestId?: string;
      mimeType?: string;
      body?: { text?: string };
    };
    if (payload.requestId === undefined) continue;
    const request = pending.get(payload.requestId);
    if (request === undefined) continue;
    pending.delete(payload.requestId);

    const text = payload.body?.text;
    if (text === undefined || text === "") continue;
    // A server that mislabels its own bundle still served a bundle. The
    // resource type is Chrome's answer to "what did the page ask for", which
    // is the better question than what the content-type header claims.
    if (!request.script && !/javascript|ecmascript/i.test(payload.mimeType ?? "")) continue;
    if (scripts.has(request.url)) continue;

    const origin = originOf(request.url);
    scripts.set(request.url, {
      url: request.url,
      source: text,
      firstParty: firstPartyOrigins.includes(origin),
      sameSite: sites.has(site(hostOf(request.url))),
    });
  }

  return [...scripts.values()];
}

/**
 * Keep the strongest sighting of each path, and merge the rest's locations.
 *
 * A path appears in a dozen chunks of a code-split application. Reporting it
 * a dozen times buries the twenty distinct endpoints under two hundred rows,
 * and the thing a reader wants — *where* it is built — is the union of the
 * sightings rather than any one of them.
 */
function mergeCandidates(found: readonly ApiCandidate[]): readonly ApiCandidate[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const byPath = new Map<string, ApiCandidate>();

  for (const candidate of found) {
    const existing = byPath.get(candidate.path);
    if (existing === undefined) {
      byPath.set(candidate.path, candidate);
      continue;
    }
    const stronger = rank[candidate.confidence] < rank[existing.confidence];
    const winner = stronger ? candidate : existing;
    byPath.set(candidate.path, {
      ...winner,
      sources: [...existing.sources, ...candidate.sources].slice(0, 5),
    });
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface AnalyzeCapturedOptions {
  readonly events: readonly EventEnvelope[];
  readonly firstPartyOrigins: readonly string[];
  /** The page's origin, so the analyzer can tell first-party from not. */
  readonly pageOrigin: string;
  /** Whole-scan ceiling. Spending it all is reported, never silent. */
  readonly totalBudgetMs?: number | undefined;
}

/**
 * Parse what the scan captured and return what the bundles named.
 *
 * Never throws. The pipeline turns every bound into a labelled result, and a
 * scan that already succeeded must not be lost to one pathological file.
 */
export async function analyzeCapturedScripts(
  options: AnalyzeCapturedOptions,
): Promise<StaticAnalysisResult> {
  const started = Date.now();
  const scripts = capturedScripts(options.events, options.firstPartyOrigins);
  const skipped: Record<string, number> = {};
  const note = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  if (scripts.length === 0) {
    return {
      candidates: [],
      basePaths: [],
      analysed: 0,
      skipped,
      partial: 0,
      durationMs: Date.now() - started,
    };
  }

  const sizes = new Map(
    scripts.map((script) => [script.url, Buffer.byteLength(script.source)]),
  );
  const facts = scripts.map((script): AssetFacts => ({
    url: script.url,
    origin: originOf(script.url),
    bytes: sizes.get(script.url) ?? 0,
    firstParty: script.firstParty,
    sameSite: script.sameSite,
    executed: true,
  }));

  const verdicts = facts.map((asset) => triage(asset));
  for (const verdict of verdicts) {
    if (verdict.skip !== undefined) note(verdict.skip.split(":")[0] as string);
  }

  const byUrl = new Map(scripts.map((script) => [script.url, script]));
  const pipeline = createAnalysisPipeline({
    analyzer: createTreeSitterAnalyzer(),
    ...(options.totalBudgetMs === undefined
      ? {}
      : { bounds: { totalBudgetMs: options.totalBudgetMs } }),
  });

  const candidates: ApiCandidate[] = [];
  const basePaths = new Set<string>();
  let analysed = 0;
  let partial = 0;

  // Highest-value bundle first, so a spent budget costs the least interesting
  // files rather than whichever happened to sort last.
  for (const verdict of orderForAnalysis(verdicts, sizes)) {
    const script = byUrl.get(verdict.url);
    if (script === undefined) continue;

    const { result, bounded } = await pipeline.analyze({
      script: script.url,
      source: script.source,
      pageOrigin: options.pageOrigin,
    });

    if (bounded !== undefined) {
      note(bounded);
      continue;
    }

    analysed += 1;
    if (result.status === "partial") partial += 1;
    candidates.push(...result.apis);

    for (const entry of result.config) {
      // Only literals. §10A.5 is explicit that an unresolved expression must
      // not be turned into a value, and a wrong base silently mis-correlates
      // every candidate under it.
      if (entry.value === undefined) continue;
      const path = entry.value.startsWith("/")
        ? entry.value
        : (() => {
            try {
              return new URL(entry.value).pathname;
            } catch {
              return undefined;
            }
          })();
      if (path !== undefined && path !== "/" && path !== "") basePaths.add(path);
    }
  }

  return {
    candidates: mergeCandidates(candidates),
    basePaths: [...basePaths].sort(),
    analysed,
    skipped,
    partial,
    durationMs: Date.now() - started,
  };
}
