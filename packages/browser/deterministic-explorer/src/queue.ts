/**
 * The visit queue — build plan §5A.1, §5A.2, §5A.5; dev plan BR-M1-12.
 *
 * §5A.5 is the requirement that shapes everything here: given the same
 * fixture, policy and candidate list, the Explorer must visit pages in the
 * same order across runs. Without that, §36.2's golden output compares two
 * different scans and the "deterministic" claim in §44 is aspirational.
 *
 * Determinism is easy to lose by accident. A `Set` iterated in insertion
 * order is fine; a `Map` keyed by object identity is not. Sorting by a
 * timestamp is not. Anything that depends on which request finished first is
 * not. So ordering here is by an explicit comparator over stable fields, and
 * ties break on the URL — never on arrival.
 *
 * ## Every skip has a reason
 *
 * §10C's coverage accounting has to distinguish "we did not visit this
 * because you told us not to" from "we could not reach it" from "we ran out
 * of budget". A queue that silently drops a URL makes coverage a guess, so
 * nothing is dropped without a recorded reason.
 */
import { normalizeIdentity } from "./identity.js";

/** Where a candidate came from. Also the default priority order. */
export const DISCOVERY_SOURCES = [
  /** The origin the user pointed us at. Always first. */
  "seed",
  /** Found in the DOM of a page we visited — the strongest runtime signal. */
  "dom_link",
  /** Declared by the site itself. */
  "sitemap",
  /** Mined out of JavaScript (§10A). */
  "js_mining",
  /** Imported from a crawler (§10D.1). Breadth, not runtime evidence. */
  "imported",
  /** Named in robots.txt, including its Disallow list. */
  "robots",
] as const;

export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

const SOURCE_RANK = new Map<DiscoverySource, number>(
  DISCOVERY_SOURCES.map((source, index) => [source, index]),
);

export interface Candidate {
  readonly url: string;
  readonly source: DiscoverySource;
  /** How many links deep from the seed. Shallower first. */
  readonly depth: number;
  /** The page it was found on, for explaining why it is in the queue. */
  readonly foundOn?: string | undefined;
}

/** Why a candidate was not visited. Feeds §10C coverage accounting. */
export const SKIP_REASONS = [
  "already_visited",
  "out_of_scope",
  "policy_denied",
  "not_http",
  "duplicate_in_queue",
  "budget_exhausted",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export interface Skipped {
  readonly url: string;
  readonly reason: SkipReason;
  readonly detail?: string | undefined;
  readonly source: DiscoverySource;
}

/**
 * Order two candidates.
 *
 * Exported so the ordering rule is testable on its own, which is the only way
 * to be sure §5A.5 holds: a test that runs the whole Explorer twice proves it
 * was deterministic *that time*.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.depth !== b.depth) return a.depth - b.depth;

  const rankA = SOURCE_RANK.get(a.source) ?? DISCOVERY_SOURCES.length;
  const rankB = SOURCE_RANK.get(b.source) ?? DISCOVERY_SOURCES.length;
  if (rankA !== rankB) return rankA - rankB;

  // The tiebreak that makes the whole thing reproducible. Anything that
  // depended on insertion order would make the queue a function of which
  // network response happened to land first.
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

export interface QueueOptions {
  /** Decides scope. Returns undefined to allow, or a reason to refuse. */
  readonly refuse: (url: string) => { reason: SkipReason; detail: string } | undefined;
}

export interface VisitQueue {
  /** Offer a candidate. Returns whether it was queued, and why not if not. */
  offer(candidate: Candidate): Skipped | undefined;
  /** The next URL to visit, or undefined when the queue is empty. */
  take(): Candidate | undefined;
  /** Mark a URL visited, so it is never offered again. */
  markVisited(url: string): void;
  readonly pending: number;
  readonly visited: readonly string[];
  readonly skipped: readonly Skipped[];
  /** Everything still queued, in visit order. Used by tests and reports. */
  peekAll(): readonly Candidate[];
}

export function createQueue(options: QueueOptions): VisitQueue {
  const queued = new Map<string, Candidate>();
  const visited = new Set<string>();
  const skipped: Skipped[] = [];

  return {
    offer(candidate) {
      const identity = normalizeIdentity(candidate.url);
      if (identity === undefined) {
        const skip: Skipped = {
          url: candidate.url,
          reason: "not_http",
          detail: "not an http(s) URL",
          source: candidate.source,
        };
        skipped.push(skip);
        return skip;
      }

      if (visited.has(identity)) {
        const skip: Skipped = {
          url: candidate.url,
          reason: "already_visited",
          source: candidate.source,
        };
        skipped.push(skip);
        return skip;
      }

      if (queued.has(identity)) {
        // Not recorded as a skip worth reporting — the URL is going to be
        // visited, just not twice. Counting it would inflate the "we did not
        // reach this" number coverage reads.
        return { url: candidate.url, reason: "duplicate_in_queue", source: candidate.source };
      }

      const refusal = options.refuse(candidate.url);
      if (refusal !== undefined) {
        const skip: Skipped = {
          url: candidate.url,
          reason: refusal.reason,
          detail: refusal.detail,
          source: candidate.source,
        };
        skipped.push(skip);
        return skip;
      }

      queued.set(identity, candidate);
      return undefined;
    },

    take() {
      if (queued.size === 0) return undefined;
      // Sorted on every take rather than kept sorted, because candidates
      // arrive while the queue is being drained and a shallower one found
      // late must still go first. The cost is trivial at these sizes and the
      // alternative is a heap whose tie-breaking is easy to get subtly wrong.
      const next = [...queued.values()].sort(compareCandidates)[0];
      if (next === undefined) return undefined;
      const identity = normalizeIdentity(next.url);
      if (identity !== undefined) queued.delete(identity);
      return next;
    },

    markVisited(url) {
      const identity = normalizeIdentity(url);
      if (identity !== undefined) visited.add(identity);
    },

    get pending() {
      return queued.size;
    },
    get visited() {
      return [...visited];
    },
    get skipped() {
      return [...skipped];
    },
    peekAll() {
      return [...queued.values()].sort(compareCandidates);
    },
  };
}
