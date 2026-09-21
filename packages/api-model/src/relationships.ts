/**
 * Typed causality — build plan §15, §14.1; dev plan BR-M2-02, BR-M2-03.
 *
 * §15 is blunt about the failure to avoid: *do not infer causality solely
 * from timestamps*. Two requests that happened in order are two requests
 * that happened in order. Presenting that as "B depends on A" invents a
 * dependency the data does not support, and a reader acting on it will try
 * to exploit an ordering that was never required.
 *
 * So every edge carries the evidence that produced it, and the five kinds
 * are graded by how much they claim:
 *
 *   `direct`               the browser told us — an initiator stack naming
 *                          the script frame, a redirect chain
 *   `inferred`             a structural link we can point at, such as an id
 *                          appearing in A's response and B's URL
 *   `temporal`             adjacency only. The weakest, and named so a
 *                          consumer can drop it wholesale
 *   `sequence_candidate`   repeatedly adjacent across runs of the same
 *                          workflow — worth a look, not a claim
 *   `dependency_candidate` B never observed without A first. Suggestive of
 *                          a requirement; not proof of one
 *
 * A consumer that wants only what the browser actually reported filters to
 * `direct`. That filter is the reason the taxonomy exists.
 */

export const RELATIONSHIP_KINDS = [
  "direct",
  "inferred",
  "temporal",
  "sequence_candidate",
  "dependency_candidate",
] as const;

export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

/** Kinds that assert the browser told us, rather than that we worked it out. */
export const OBSERVED_KINDS: ReadonlySet<RelationshipKind> = new Set<RelationshipKind>([
  "direct",
]);

export interface Relationship {
  /** `evt_000042`, `int_0003`, `api_0007` — always a resolvable id. */
  readonly target: string;
  readonly kind: RelationshipKind;
  /**
   * What produced this edge, in words.
   *
   * Mandatory. An edge with no stated basis is one nobody can check, and
   * the whole point of grading the kinds is that a reader can decide how
   * much to trust each one — which needs the reason, not just the label.
   */
  readonly basis: string;
}

/**
 * How much an edge claims, for sorting and filtering.
 *
 * Lower is stronger. Used to keep the strongest edge when two rules produce
 * one for the same pair: a `direct` edge and a `temporal` edge between the
 * same two requests is a `direct` edge, and keeping both would let a
 * consumer counting `temporal` edges double-report it.
 */
export const RELATIONSHIP_STRENGTH: Readonly<Record<RelationshipKind, number>> = {
  direct: 0,
  inferred: 1,
  dependency_candidate: 2,
  sequence_candidate: 3,
  temporal: 4,
};

/** Keep the strongest edge per target, deterministically ordered. */
export function reduceRelationships(edges: readonly Relationship[]): readonly Relationship[] {
  const strongest = new Map<string, Relationship>();
  for (const edge of edges) {
    const existing = strongest.get(edge.target);
    if (
      existing === undefined ||
      RELATIONSHIP_STRENGTH[edge.kind] < RELATIONSHIP_STRENGTH[existing.kind]
    ) {
      strongest.set(edge.target, edge);
    }
  }
  return [...strongest.values()].sort(
    (a, b) =>
      RELATIONSHIP_STRENGTH[a.kind] - RELATIONSHIP_STRENGTH[b.kind] ||
      a.target.localeCompare(b.target),
  );
}

/** One frame of a CDP initiator stack, already flattened by telemetry. */
export interface InitiatorFrame {
  readonly raw: string;
  readonly functionName?: string | undefined;
  readonly url?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

/**
 * Parse `function@url:line:col` back into parts.
 *
 * Telemetry flattens CDP's nested stack to strings because neither a
 * correlation rule nor a human benefits from the tree. Reading them back
 * here keeps that decision intact while still letting the model name a
 * script and a line — which §14.1's `initiator` block requires.
 *
 * Returns the raw string unparsed rather than throwing: a frame we cannot
 * split is still evidence of *a* frame, and dropping it would understate
 * the depth of the chain.
 */
export function parseFrame(raw: string): InitiatorFrame {
  const at = raw.lastIndexOf("@");
  if (at === -1) return { raw };

  const functionName = raw.slice(0, at);
  const location = raw.slice(at + 1);

  // Split from the right: a URL contains colons (scheme, port) and the last
  // two are the position. Matching from the left would take `https` as the
  // function's file.
  const match = /^(.*):(\d+):(\d+)$/.exec(location);
  if (match === null) {
    return {
      raw,
      ...(functionName === "" ? {} : { functionName }),
      ...(location === "" ? {} : { url: location }),
    };
  }

  return {
    raw,
    ...(functionName === "" ? {} : { functionName }),
    url: match[1] ?? "",
    line: Number(match[2]),
    column: Number(match[3]),
  };
}

export interface InitiatorChain {
  /** CDP's own word: `parser`, `script`, `preload`, `preflight`, `other`. */
  readonly type: string;
  /** The script Chrome blamed, where it named one. */
  readonly source?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  /** Innermost first. Empty for a parser-initiated request, which is normal. */
  readonly frames: readonly InitiatorFrame[];
  /** Distinct scripts in the chain, outermost last. For asset attribution. */
  readonly scripts: readonly string[];
}

export interface RawInitiator {
  readonly type?: string | undefined;
  readonly url?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly columnNumber?: number | undefined;
  readonly stack?: readonly string[] | undefined;
}

/**
 * Build the chain §15 asks for from what telemetry recorded.
 *
 * A `parser` initiator with no stack is not a gap — it means the HTML
 * referenced the resource directly, which is a fact worth keeping rather
 * than an absence to apologise for.
 */
export function buildInitiatorChain(initiator: RawInitiator | undefined): InitiatorChain {
  const frames = (initiator?.stack ?? []).map(parseFrame);

  const scripts: string[] = [];
  for (const frame of frames) {
    if (frame.url !== undefined && frame.url !== "" && !scripts.includes(frame.url)) {
      scripts.push(frame.url);
    }
  }
  // Chrome's own attribution, when it named a script the stack did not.
  if (
    initiator?.url !== undefined &&
    initiator.url !== "" &&
    !scripts.includes(initiator.url)
  ) {
    scripts.push(initiator.url);
  }

  return {
    type: initiator?.type ?? "other",
    ...(initiator?.url === undefined ? {} : { source: initiator.url }),
    ...(initiator?.lineNumber === undefined ? {} : { line: initiator.lineNumber }),
    ...(initiator?.columnNumber === undefined ? {} : { column: initiator.columnNumber }),
    frames,
    scripts,
  };
}

/**
 * The edge a request's own initiator justifies.
 *
 * `direct` only when Chrome named a script: that is the browser reporting
 * causality rather than us reconstructing it. A `parser` initiator gets no
 * edge at all — "the HTML asked for it" is context, not a cause worth
 * putting in a dependency graph.
 */
export function edgeFromInitiator(
  chain: InitiatorChain,
  scriptToId: (url: string) => string | undefined,
): Relationship | undefined {
  if (chain.type !== "script") return undefined;
  const script = chain.scripts[0] ?? chain.source;
  if (script === undefined) return undefined;

  const id = scriptToId(script);
  if (id === undefined) return undefined;

  return {
    target: id,
    kind: "direct",
    basis: `initiated by ${script}${chain.line === undefined ? "" : `:${chain.line}`}`,
  };
}
