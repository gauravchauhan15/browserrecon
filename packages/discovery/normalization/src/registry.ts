/**
 * The shared candidate registry — build plan §9.5.1, §10A.3; dev plan BR-M1-16.
 *
 * Every discovery source finds overlapping URLs. Katana crawls `/api/orders`,
 * JS mining finds it in a bundle, and the page links to it. Three entries
 * would make the coverage numbers nonsense and the Explorer visit it three
 * times; one entry that remembers all three sources is strictly more
 * informative than any of them — "found by the crawler AND written in the
 * JavaScript AND linked from the page" is a different fact from any single
 * sighting.
 *
 * ## Status is a transition, not a flag
 *
 * §10C's coverage accounting is the difference between `discovered` and
 * `observed`: a URL a crawler listed is not evidence of anything until the
 * browser actually visited it (§5A.3). The registry records which event moved
 * an entry, so "we found 4,000 URLs and observed 300" can be explained rather
 * than asserted.
 */
import { inferTemplate } from "@browserrecon/collector-network";

export type CandidateStatus = "discovered" | "observed" | "unobserved";

export interface SourceSighting {
  readonly source: string;
  /** Where this source saw it — the page, the bundle, the crawler's run. */
  readonly foundOn?: string | undefined;
  /** Envelope sequence, so a sighting can be traced back to its event. */
  readonly sequence?: number | undefined;
}

export interface CandidateEntry {
  /** Normalized URL — the registry key. */
  readonly url: string;
  readonly origin: string;
  /** Route template this belongs to (§9.5.2), when one could be inferred. */
  readonly template?: string | undefined;
  /** Every source that found it, in first-seen order, deduplicated. */
  readonly sources: readonly SourceSighting[];
  readonly status: CandidateStatus;
  /** What moved it out of `discovered`, so the transition is explainable. */
  readonly statusReason?: string | undefined;
}

export interface RegistryStats {
  readonly total: number;
  readonly observed: number;
  readonly unobserved: number;
  readonly discovered: number;
  /** Entries per discovery source. Sums to more than `total` by design. */
  readonly bySource: ReadonlyMap<string, number>;
  readonly templates: number;
}

export interface CandidateRegistry {
  /** Add or merge a sighting. Returns the entry as it now stands. */
  add(url: string, sighting: SourceSighting): CandidateEntry | undefined;
  /** Record that the browser visited it. */
  markObserved(url: string, reason: string): void;
  /** Record that it was reachable but deliberately not visited. */
  markUnobserved(url: string, reason: string): void;
  get(url: string): CandidateEntry | undefined;
  /** Every entry, ordered by URL so output is reproducible. */
  all(): readonly CandidateEntry[];
  /** Entries grouped by route template, templates ordered by URL. */
  byTemplate(): ReadonlyMap<string, readonly CandidateEntry[]>;
  readonly stats: RegistryStats;
}

/**
 * The registry's key.
 *
 * Fragment dropped — it never reaches the server — and nothing else touched.
 * Matching the Explorer's page identity rather than the network collector's
 * endpoint identity is deliberate: this decides what gets *visited*, and
 * over-merging here loses coverage.
 */
function key(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function createRegistry(): CandidateRegistry {
  const entries = new Map<string, CandidateEntry>();

  return {
    add(url, sighting) {
      const id = key(url);
      if (id === undefined) return undefined;

      const existing = entries.get(id);
      if (existing === undefined) {
        const template = inferTemplate(id);
        const created: CandidateEntry = {
          url: id,
          origin: new URL(id).origin,
          ...(template === undefined ? {} : { template: template.template }),
          sources: [sighting],
          status: "discovered",
        };
        entries.set(id, created);
        return created;
      }

      // One sighting per source. A crawler that lists the same URL twice, or
      // a page that links to it from three places, is still one source
      // saying one thing — counting it twice would inflate the corroboration
      // that multi-source agreement is supposed to represent.
      if (existing.sources.some((seen) => seen.source === sighting.source)) return existing;

      const merged: CandidateEntry = { ...existing, sources: [...existing.sources, sighting] };
      entries.set(id, merged);
      return merged;
    },

    markObserved(url, reason) {
      const id = key(url);
      const existing = id === undefined ? undefined : entries.get(id);
      if (id === undefined || existing === undefined) return;
      entries.set(id, { ...existing, status: "observed", statusReason: reason });
    },

    markUnobserved(url, reason) {
      const id = key(url);
      const existing = id === undefined ? undefined : entries.get(id);
      if (id === undefined || existing === undefined) return;
      // Deliberately does not downgrade something already observed. A URL
      // visited once stays observed even if a later pass skips it.
      if (existing.status === "observed") return;
      entries.set(id, { ...existing, status: "unobserved", statusReason: reason });
    },

    get(url) {
      const id = key(url);
      return id === undefined ? undefined : entries.get(id);
    },

    all() {
      return [...entries.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    },

    byTemplate() {
      const grouped = new Map<string, CandidateEntry[]>();
      for (const entry of this.all()) {
        const template = entry.template ?? entry.url;
        const list = grouped.get(template);
        if (list === undefined) grouped.set(template, [entry]);
        else list.push(entry);
      }
      return new Map([...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    },

    get stats(): RegistryStats {
      const list = [...entries.values()];
      const bySource = new Map<string, number>();
      for (const entry of list) {
        for (const sighting of entry.sources) {
          bySource.set(sighting.source, (bySource.get(sighting.source) ?? 0) + 1);
        }
      }
      return {
        total: list.length,
        observed: list.filter((entry) => entry.status === "observed").length,
        unobserved: list.filter((entry) => entry.status === "unobserved").length,
        discovered: list.filter((entry) => entry.status === "discovered").length,
        bySource,
        templates: new Set(list.map((entry) => entry.template ?? entry.url)).size,
      };
    },
  };
}
