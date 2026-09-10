/**
 * Deterministic identifiers — dev plan §1 (locked decisions).
 *
 * IDs are monotonic per session and prefixed per entity kind. They are
 * **never** random UUIDs, and this is a hard requirement rather than a
 * preference: golden-output tests (build plan §36.2) compare normalized scan
 * output across runs, and a random identifier makes every comparison fail.
 * Retrofitting this later would mean rewriting every fixture.
 *
 * The guarantee is narrow and precise: for one session, the same *sequence of
 * requests* yields the same IDs. It is not a hash of content — two different
 * scans both start at 1.
 */

/**
 * Entity kinds that carry an ID, with the zero-padding width used when
 * formatting. Width is declared here rather than inline so lexicographic
 * sorting of a JSONL file matches numeric order — someone will `sort` an
 * event log, and `evt_10` sorting before `evt_9` is a bad afternoon.
 *
 * Events get a wider field because a single scan produces far more of them
 * than anything else.
 */
export const ID_KINDS = {
  session: { prefix: "sess", width: 4 },
  event: { prefix: "evt", width: 6 },
  page: { prefix: "page", width: 4 },
  navigation: { prefix: "nav", width: 4 },
  interaction: { prefix: "int", width: 4 },
  request: { prefix: "req", width: 6 },
  api: { prefix: "api", width: 4 },
  sequence: { prefix: "seq", width: 4 },
  workflow: { prefix: "wf", width: 4 },
  state: { prefix: "state", width: 4 },
  script: { prefix: "js", width: 4 },
  asset: { prefix: "asset", width: 4 },
  candidate: { prefix: "cand", width: 4 },
  gap: { prefix: "gap", width: 4 },
  barrier: { prefix: "barrier", width: 4 },
  webmcpTool: { prefix: "tool", width: 4 },
  hypothesis: { prefix: "hyp", width: 4 },
  association: { prefix: "assoc", width: 4 },
  agentStep: { prefix: "step", width: 4 },
} as const satisfies Record<string, { prefix: string; width: number }>;

/** Every entity kind that can be assigned an ID. */
export type IdKind = keyof typeof ID_KINDS;

/** A formatted identifier, e.g. `evt_000042`. */
export type Id = string;

const KIND_BY_PREFIX: ReadonlyMap<string, IdKind> = new Map(
  Object.entries(ID_KINDS).map(([kind, { prefix }]) => [prefix, kind as IdKind]),
);

function format(kind: IdKind, ordinal: number): Id {
  const { prefix, width } = ID_KINDS[kind];
  return `${prefix}_${String(ordinal).padStart(width, "0")}`;
}

/**
 * Allocates IDs for one session.
 *
 * One factory per scan session. Counters are per kind, so events and pages
 * number independently — an event log stays readable when a scan produces
 * 40,000 events across 30 pages.
 */
export class IdFactory {
  readonly #counters = new Map<IdKind, number>();

  /**
   * @param sessionOrdinal Which session this is on the machine. Only used to
   * format the session's own ID; it does not seed the other counters, because
   * event IDs must not shift when a user happens to run a second scan.
   */
  constructor(private readonly sessionOrdinal: number = 1) {
    if (!Number.isInteger(sessionOrdinal) || sessionOrdinal < 1) {
      throw new RangeError(`sessionOrdinal must be a positive integer, got ${sessionOrdinal}`);
    }
  }

  /** This session's own ID. Stable for the factory's lifetime. */
  get sessionId(): Id {
    return format("session", this.sessionOrdinal);
  }

  /** Allocate the next ID for a kind. */
  next(kind: IdKind): Id {
    const ordinal = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, ordinal);
    return format(kind, ordinal);
  }

  /** How many IDs of a kind have been allocated. Used by scan statistics. */
  count(kind: IdKind): number {
    return this.#counters.get(kind) ?? 0;
  }

  /**
   * Counters as a plain object, for the session checkpoint.
   *
   * Resuming a scan (build plan §30) must continue numbering rather than
   * restart it, or a resumed session would emit duplicate IDs that silently
   * collide with the ones already persisted.
   */
  snapshot(): Readonly<Partial<Record<IdKind, number>>> {
    return Object.fromEntries(this.#counters);
  }

  /** Restore counters from a checkpoint, for `browserrecon resume`. */
  static restore(
    sessionOrdinal: number,
    counters: Readonly<Partial<Record<IdKind, number>>>,
  ): IdFactory {
    const factory = new IdFactory(sessionOrdinal);
    for (const [kind, ordinal] of Object.entries(counters)) {
      if (ordinal === undefined) continue;
      if (!(kind in ID_KINDS)) {
        throw new TypeError(`unknown id kind in checkpoint: ${kind}`);
      }
      if (!Number.isInteger(ordinal) || ordinal < 0) {
        throw new RangeError(`invalid counter for ${kind}: ${ordinal}`);
      }
      factory.#counters.set(kind as IdKind, ordinal);
    }
    return factory;
  }
}

/** Whether a string is a well-formed ID for the given kind. */
export function isId(value: unknown, kind: IdKind): boolean {
  if (typeof value !== "string") return false;
  const { prefix, width } = ID_KINDS[kind];
  return new RegExp(`^${prefix}_\\d{${width},}$`).test(value);
}

/** The entity kind an ID belongs to, or undefined if unrecognised. */
export function idKindOf(value: string): IdKind | undefined {
  const separator = value.lastIndexOf("_");
  if (separator <= 0) return undefined;
  const prefix = value.slice(0, separator);
  const digits = value.slice(separator + 1);
  if (!/^\d+$/.test(digits)) return undefined;
  return KIND_BY_PREFIX.get(prefix);
}
