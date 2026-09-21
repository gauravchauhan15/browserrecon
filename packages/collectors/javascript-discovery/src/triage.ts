/**
 * Asset triage — build plan §10B.3, §10B.7; dev plan BR-M2-08.
 *
 * A scan of a real application finds sixty JavaScript assets and has budget
 * to deeply parse perhaps fifteen. Which fifteen decides what the scan
 * finds, so this is not housekeeping — it is the single decision that most
 * affects the result.
 *
 * ## Metadata before parsing
 *
 * §10B.3 lists what to compute first, and every item on it is cheap: size,
 * origin, whether it executed, whether it produced traffic, its content
 * hash. Parsing is the expensive step and it comes last, informed by all of
 * them.
 *
 * ## Runtime evidence beats naming
 *
 * §10B.7. A third-party script named `vendor.min.js` that turns out to
 * initiate the application's API calls is more interesting than a
 * first-party file that executed and did nothing. Static priority is a
 * starting guess; observed behaviour overrides it, and the reason is
 * recorded so a report can say why a file was read first.
 */

/** §10B.3's bands. Lower is analysed sooner. */
export const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;

export type Priority = (typeof PRIORITIES)[number];

export interface AssetFacts {
  readonly url: string;
  readonly origin: string;
  readonly bytes?: number | undefined;
  readonly contentHash?: string | undefined;
  /** Same origin as the page under scan. */
  readonly firstParty: boolean;
  /** Shares a registrable domain but not an origin. */
  readonly sameSite?: boolean | undefined;
  /** False for a script that was fetched but never ran. */
  readonly executed?: boolean | undefined;
  /** Arrived after the initial load — a route or feature chunk (§10B.6). */
  readonly lazy?: boolean | undefined;
  readonly hasSourceMap?: boolean | undefined;
  /** True when this exact content was already analysed (§10B.5). */
  readonly alreadyAnalysed?: boolean | undefined;
}

/** §10B.7's signals. Each one is something the runtime actually showed. */
export interface RuntimeSignals {
  /** Named as the initiator of at least one request. */
  readonly initiatedRequests?: number | undefined;
  /** Appears anywhere in an initiator chain, not necessarily at its head. */
  readonly inInitiatorChain?: boolean | undefined;
  readonly participatedInNavigation?: boolean | undefined;
  /** Loaded immediately before a workflow began. */
  readonly precededWorkflow?: boolean | undefined;
  readonly registeredWebMcpTools?: number | undefined;
  /** Static analysis of a cheaper pass found first-party or API origins. */
  readonly namesApiOrigins?: boolean | undefined;
  /** Associated with a route the scan has not reached. */
  readonly associatedWithUnexploredRoute?: boolean | undefined;
}

export interface TriageVerdict {
  readonly url: string;
  readonly priority: Priority;
  /** Before runtime evidence was applied. Kept so the change is visible. */
  readonly basePriority: Priority;
  /** Why, in words. A priority nobody can explain is one nobody can tune. */
  readonly basis: string;
  /** Signals that raised it, named individually. */
  readonly elevatedBy: readonly string[];
  /** Set when the asset should not be parsed at all, with the reason. */
  readonly skip?: string | undefined;
}

/** Vendor content whose analysis rarely repays the time. */
const LOW_VALUE =
  /(?:^|\/)(?:jquery|lodash|moment|bootstrap|polyfill|core-js|regenerator|zone|rxjs|three|chart|d3|gsap)[.\-@]/i;

/** Names that suggest a lazily-loaded feature or route chunk. */
const CHUNK_NAME = /(?:chunk|lazy|route|page|view|async)[.\-_]|\.[0-9a-f]{8,}\.(?:js|mjs)$/i;

/**
 * Where an asset starts before runtime evidence.
 *
 * §10B.3's bands, in order. First-party executed application code is the
 * whole point of the exercise; known vendor content is last because forty
 * thousand lines of a charting library contain no endpoints of the
 * application's own.
 */
export function basePriority(asset: AssetFacts): { priority: Priority; basis: string } {
  if (asset.firstParty) {
    if (asset.lazy === true || CHUNK_NAME.test(asset.url)) {
      return { priority: "P1", basis: "first-party lazily-loaded or route-specific chunk" };
    }
    if (asset.executed === false) {
      // Fetched and never run. Still the application's own code, and its
      // strings are still evidence — but behind code that actually ran.
      return { priority: "P1", basis: "first-party code that was loaded but never executed" };
    }
    return { priority: "P0", basis: "first-party application code that executed" };
  }

  if (LOW_VALUE.test(asset.url)) {
    return { priority: "P4", basis: "recognised vendor library" };
  }

  if (asset.sameSite === true) {
    return { priority: "P2", basis: "same-site shared code" };
  }

  return { priority: "P3", basis: "third-party script" };
}

/** How far each signal is worth moving an asset. */
const ELEVATION: readonly {
  readonly signal: keyof RuntimeSignals;
  readonly steps: number;
  readonly why: string;
}[] = [
  {
    signal: "initiatedRequests",
    steps: 3,
    why: "initiated API traffic",
  },
  {
    signal: "registeredWebMcpTools",
    steps: 3,
    why: "registered WebMCP tools",
  },
  { signal: "inInitiatorChain", steps: 2, why: "appears in a request's initiator chain" },
  { signal: "precededWorkflow", steps: 2, why: "loaded immediately before a workflow began" },
  { signal: "participatedInNavigation", steps: 1, why: "participated in a navigation" },
  { signal: "namesApiOrigins", steps: 1, why: "names first-party or API origins" },
  {
    signal: "associatedWithUnexploredRoute",
    steps: 1,
    why: "associated with a route the scan has not reached",
  },
];

function stepUp(priority: Priority, steps: number): Priority {
  const index = PRIORITIES.indexOf(priority);
  return PRIORITIES[Math.max(0, index - steps)] as Priority;
}

/**
 * Triage one asset.
 *
 * `maxBytes` is the one hard stop. §10B.4's `size_limit`: the spike measured
 * resident memory growing to roughly 28x the source, so a 20 MB bundle wants
 * about 560 MB. Refusing it here costs one candidate list; letting it through
 * risks the process.
 */
export function triage(
  asset: AssetFacts,
  signals: RuntimeSignals = {},
  maxBytes?: number,
): TriageVerdict {
  const base = basePriority(asset);
  const elevatedBy: string[] = [];
  let priority = base.priority;

  for (const rule of ELEVATION) {
    const value = signals[rule.signal];
    const present = typeof value === "number" ? value > 0 : value === true;
    if (!present) continue;
    priority = stepUp(priority, rule.steps);
    elevatedBy.push(rule.why);
  }

  let skip: string | undefined;
  if (asset.alreadyAnalysed === true) {
    skip = "identical content was already analysed";
  } else if (maxBytes !== undefined && (asset.bytes ?? 0) > maxBytes) {
    skip = `size_limit: ${asset.bytes ?? 0} bytes exceeds the ${maxBytes}-byte cap`;
  }

  return {
    url: asset.url,
    priority,
    basePriority: base.priority,
    basis: base.basis,
    elevatedBy,
    ...(skip === undefined ? {} : { skip }),
  };
}

/**
 * Order a set of assets for analysis.
 *
 * Priority first, then size ascending, then URL. Size ascending because two
 * assets of equal priority are worth the same and the cheaper one finishes
 * first — under a total time budget that is strictly more findings. URL last
 * so the order is reproducible, which a golden report depends on.
 */
export function orderForAnalysis(
  verdicts: readonly TriageVerdict[],
  sizes: ReadonlyMap<string, number> = new Map(),
): readonly TriageVerdict[] {
  return [...verdicts]
    .filter((verdict) => verdict.skip === undefined)
    .sort(
      (a, b) =>
        PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) ||
        (sizes.get(a.url) ?? 0) - (sizes.get(b.url) ?? 0) ||
        a.url.localeCompare(b.url),
    );
}
