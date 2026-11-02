/**
 * Rate profiles and thoroughness levels — build plan §8.3.
 *
 * Two independent dials. Politeness governs how hard the target is hit;
 * thoroughness governs how the budget is spent. Fusing them would make
 * "gentle but thorough" — the obvious setting for your own staging
 * environment — inexpressible.
 *
 * The named-profile pattern follows Nmap's timing templates (`-T0` paranoid
 * through `-T5` insane, defaulting to `-T3` normal): a deliberately balanced
 * middle, never the most aggressive option.
 */
import type { Limits, Thoroughness } from "./types.js";

export type RateProfile = "polite" | "normal" | "aggressive";
export type ThoroughnessLevel = "shallow" | "normal" | "deep";

/**
 * Requests a single page render typically costs.
 *
 * A modern page pulls 30–80 requests — HTML, CSS, JS chunks, fonts, images,
 * API calls, analytics beacons. Used only to compute the effective budget
 * (§8.3), never to enforce anything, and deliberately a named constant rather
 * than a literal so the estimate can be corrected against real scans.
 */
export const ESTIMATED_REQUESTS_PER_PAGE = 50;

/**
 * Profile limits, sized so the page and time budgets are **arithmetically
 * coherent** with each other.
 *
 * This is the fix for a real defect: earlier drafts paired 2 req/sec with
 * `max_pages: 5000` and a 30-minute runtime, which cannot both hold —
 * 2 x 1800 = 3,600 requests, about 72 pages. The page budget was unreachable
 * by roughly 70x, so the time budget always bound first and anyone reading
 * the config badly misjudged what a scan would do.
 *
 * `maxPages` here is sized for a **120-minute** run at the profile's rate.
 * For reference, the closest peer tools are other browser-driven crawlers,
 * not port scanners: Burp's built-in configurations cap a crawl at roughly
 * 30 minutes and 1,500 unique locations, and ZAP's AJAX Spider defaults to
 * 60 minutes.
 *
 * Two hours rather than one, because the budget that matters for this tool
 * is wall-clock and the thing it is spent on is *pages*. A modern
 * application costs far more per page than a document-and-links crawler
 * assumes — the reference application spent 126 requests on a single page
 * against the 50
 * this file estimates — so an hour at a polite rate buys a sample, not a
 * crawl, and workflows and interactions are exactly what a sample misses.
 *
 * The clock is a cap, never a target: the scan paces itself to fit inside
 * it (`pageAllowanceMs`) and stops the moment the queue runs dry. A site
 * small enough to finish in ten minutes still finishes in ten minutes.
 */
/**
 * The budgets a rate profile decides.
 *
 * `maxDepth` is deliberately absent: how hard to hit a target and how far
 * to wander from the seed are independent choices (§8.3), and a profile
 * that carried a depth would make `--rate-profile polite` quietly reshape
 * the crawl as well as slow it. Expressed in the type so the next person to
 * tune these cannot add one by accident.
 */
export type RateLimits = Omit<Limits, "maxDepth">;

export const RATE_PROFILES: Readonly<Record<RateProfile, RateLimits>> = {
  /** First contact with an unfamiliar or production target. */
  polite: {
    maxRequestsPerSecond: 1,
    maxConcurrency: 1,
    maxPages: 120,
    maxRuntimeMinutes: 120,
  },
  /** Default. Balanced, in the spirit of Nmap's `-T3`. */
  normal: {
    maxRequestsPerSecond: 5,
    maxConcurrency: 2,
    maxPages: 600,
    maxRuntimeMinutes: 120,
  },
  /** Explicit opt-in, for a target you control and have load-tested (§7.4). */
  aggressive: {
    maxRequestsPerSecond: 15,
    maxConcurrency: 4,
    maxPages: 1600,
    maxRuntimeMinutes: 120,
  },
};

/** The default profile is `normal` — never `aggressive`. */
export const DEFAULT_RATE_PROFILE: RateProfile = "normal";

/**
 * Links deep from the seed, by default.
 *
 * Three, which is Katana's default and the shallow end of what peer tools
 * ship. An application's distinct surface is overwhelmingly shallow; past
 * depth three the crawl is mostly finding the same template again with a
 * different id, which §9.5.3's instance sampling is the right tool for and
 * a page budget is not. Not profile-driven: how hard to hit a target and how
 * far to wander from the seed are independent choices (§8.3), and fusing
 * them would mean `--rate-profile polite` quietly changed the shape of the
 * crawl as well as its speed.
 */
export const DEFAULT_MAX_DEPTH = 3;

/**
 * How many instances of a route template to sample (§9.5.3).
 *
 * Template saturation is what makes any of these budgets sufficient: a site
 * with 47,000 URLs across 40 distinct templates needs roughly 120 visits to
 * cover its structural surface, not 47,000.
 */
export const THOROUGHNESS_LEVELS: Readonly<Record<ThoroughnessLevel, Thoroughness>> = {
  shallow: { instancesPerTemplate: 1, divergenceSampleCap: 3 },
  normal: { instancesPerTemplate: 3, divergenceSampleCap: 10 },
  deep: { instancesPerTemplate: 8, divergenceSampleCap: 40 },
};

export const DEFAULT_THOROUGHNESS_LEVEL: ThoroughnessLevel = "normal";

/** Which configured limit actually stops the scan first. */
export type BindingConstraint = "pages" | "time";

export interface EffectiveBudget {
  /** Requests the rate and runtime together allow. */
  readonly requestsAvailable: number;
  /** Pages those requests buy, at `ESTIMATED_REQUESTS_PER_PAGE`. */
  readonly pagesReachable: number;
  /** The page count the scan will actually reach. */
  readonly effectivePages: number;
  readonly binding: BindingConstraint;
  /** True when `maxPages` is set so high it can never be reached. */
  readonly maxPagesUnreachable: boolean;
}

/**
 * Work out what a policy's limits mean together.
 *
 * Users cannot reason about interacting budgets in their heads, so §8.3
 * requires the tool to do the arithmetic and print it at scan start. This is
 * that calculation; rendering is the CLI's job.
 */
export function computeEffectiveBudget(limits: RateLimits): EffectiveBudget {
  const requestsAvailable = limits.maxRequestsPerSecond * limits.maxRuntimeMinutes * 60;
  const pagesReachable = Math.floor(requestsAvailable / ESTIMATED_REQUESTS_PER_PAGE);
  const timeBound = pagesReachable < limits.maxPages;

  return {
    requestsAvailable,
    pagesReachable,
    effectivePages: Math.min(limits.maxPages, pagesReachable),
    binding: timeBound ? "time" : "pages",
    // Flagged at 2x rather than any shortfall: a page budget slightly above
    // what the clock allows is a reasonable headroom choice, whereas one many
    // times higher is a misconfiguration the user should be told about.
    maxPagesUnreachable: limits.maxPages > pagesReachable * 2,
  };
}
