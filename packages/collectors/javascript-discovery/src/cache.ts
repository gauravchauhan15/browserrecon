/**
 * Content dedup and the analysis cache — build plan §10B.5, §10B.8;
 * dev plan BR-M2-10.
 *
 * A shared vendor chunk is served from three CDN paths, referenced by forty
 * pages, and arrives with a cache-busting query string that changes per
 * deploy. Analysing it forty times costs forty times the compute to learn
 * the same thing, and inflates every "assets analysed" figure a coverage
 * report prints.
 *
 * ## The cache key includes the rules, not just the content
 *
 * §10B.8. Keying on the content hash alone means that when extraction
 * improves, every bundle anyone has already scanned keeps serving the old,
 * worse answer — and nobody notices, because the improvement is invisible
 * exactly where there is history to compare against. The parser version and
 * the rule version are in the key so a better rule invalidates its own
 * cache.
 *
 * ## What dedup does not collapse
 *
 * Identical content at two URLs is one analysis and **two assets**. The
 * second URL is still a fact about the application — which pages load it,
 * from which origins — and §10B.5's record keeps `all_seen_urls`,
 * `origins` and `pages_loaded_from` for that reason. Collapsing the sightings
 * along with the analysis would lose the reach of a vendor script, which is
 * precisely what makes one interesting.
 */
import { createHash } from "node:crypto";
import type { AnalysisResult } from "./analyzer.js";

/** §10B.5's record for one distinct piece of content. */
export interface ContentRecord {
  readonly contentHash: string;
  readonly firstSeenUrl: string;
  readonly allSeenUrls: readonly string[];
  readonly origins: readonly string[];
  readonly pagesLoadedFrom: readonly string[];
  readonly bytes: number;
  readonly analysisStatus?: AnalysisResult["status"] | undefined;
  /** The rule version the stored analysis was produced with. */
  readonly analysisVersion?: string | undefined;
}

export interface Sighting {
  readonly url: string;
  readonly origin: string;
  /** The page that loaded it. Absent for a worker or a service worker. */
  readonly page?: string | undefined;
  readonly bytes: number;
}

/**
 * Hash content the same way everywhere.
 *
 * Chrome supplies its own hash for scripts it loaded, and that one is used
 * when present — it is free and exact. This is for content Chrome did not
 * hash: an inline block, a body reconstructed from a stream.
 */
export function hashContent(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

export interface CacheKeyParts {
  readonly contentHash: string;
  readonly parserVersion: string;
  readonly ruleVersion: string;
  /** §10B.8: a different source map changes what analysis can resolve. */
  readonly sourceMapHash?: string | undefined;
}

export function cacheKey(parts: CacheKeyParts): string {
  return [
    parts.contentHash,
    parts.parserVersion,
    parts.ruleVersion,
    parts.sourceMapHash ?? "-",
  ].join("|");
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  /** Sightings of content already analysed — the §10B.5 saving. */
  readonly duplicateSightings: number;
  readonly distinctContent: number;
}

export interface AnalysisCache {
  /**
   * Record that this content was seen at a URL.
   *
   * Returns the record, so a caller can tell a first sighting from a repeat
   * without a second lookup.
   */
  see(contentHash: string, sighting: Sighting): ContentRecord;
  get(parts: CacheKeyParts): AnalysisResult | undefined;
  put(parts: CacheKeyParts, result: AnalysisResult): void;
  /** Every distinct piece of content, sorted by hash for reproducibility. */
  records(): readonly ContentRecord[];
  readonly stats: CacheStats;
}

/** How many URLs to remember per piece of content. */
const MAX_URLS_PER_CONTENT = 50;

export interface CacheOptions {
  /**
   * Entries kept before the oldest is evicted.
   *
   * A cap rather than unbounded: a scan of a site that serves a uniquely
   * hashed bundle per page would otherwise hold every one of them for the
   * whole run, which is the shape of leak §41 is about.
   */
  readonly maxEntries?: number | undefined;
}

const DEFAULT_MAX_ENTRIES = 500;

export function createAnalysisCache(options: CacheOptions = {}): AnalysisCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const results = new Map<string, AnalysisResult>();
  const content = new Map<string, ContentRecord>();

  let hits = 0;
  let misses = 0;
  let duplicateSightings = 0;

  return {
    see(contentHash, sighting) {
      const existing = content.get(contentHash);
      if (existing === undefined) {
        const record: ContentRecord = {
          contentHash,
          firstSeenUrl: sighting.url,
          allSeenUrls: [sighting.url],
          origins: [sighting.origin],
          pagesLoadedFrom: sighting.page === undefined ? [] : [sighting.page],
          bytes: sighting.bytes,
        };
        content.set(contentHash, record);
        return record;
      }

      duplicateSightings += 1;
      const merge = (into: readonly string[], value: string | undefined): readonly string[] =>
        value === undefined || into.includes(value) || into.length >= MAX_URLS_PER_CONTENT
          ? into
          : [...into, value];

      const updated: ContentRecord = {
        ...existing,
        allSeenUrls: merge(existing.allSeenUrls, sighting.url),
        origins: merge(existing.origins, sighting.origin),
        pagesLoadedFrom: merge(existing.pagesLoadedFrom, sighting.page),
      };
      content.set(contentHash, updated);
      return updated;
    },

    get(parts) {
      const found = results.get(cacheKey(parts));
      if (found === undefined) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      // Re-inserted so the eviction order is least-recently-used rather than
      // insertion order: a vendor chunk hit on every page should not be the
      // first thing dropped.
      results.delete(cacheKey(parts));
      results.set(cacheKey(parts), found);
      return found;
    },

    put(parts, result) {
      const key = cacheKey(parts);
      results.delete(key);
      results.set(key, result);

      const record = content.get(parts.contentHash);
      if (record !== undefined) {
        content.set(parts.contentHash, {
          ...record,
          analysisStatus: result.status,
          analysisVersion: parts.ruleVersion,
        });
      }

      while (results.size > maxEntries) {
        const oldest = results.keys().next();
        if (oldest.done === true) break;
        results.delete(oldest.value);
      }
    },

    records() {
      return [...content.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash));
    },

    get stats() {
      return {
        hits,
        misses,
        duplicateSightings,
        distinctContent: content.size,
      };
    },
  };
}
