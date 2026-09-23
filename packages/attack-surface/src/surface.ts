/**
 * The attack-surface model — build plan §23, §35B.5; dev plan BR-M3-10.
 *
 * The one object a downstream scanner consumes. Everything before this built
 * a piece of the picture; this assembles them and — the part that makes it
 * worth consuming — keeps every piece traceable back to a raw observation.
 *
 * ## The traceability chain is the product
 *
 * §35B.5: "any claim in `report.md` can be walked back to the raw
 * observations that produced it. **A derived object without resolvable source
 * IDs is a bug.**"
 *
 * That is stronger than it looks. It means a surface item must carry the
 * workflow it belongs to, which carries the API events it contains, which
 * carry the request/response envelopes, which carry the interaction and
 * navigation that caused them. Break the chain anywhere and the item becomes
 * an assertion — indistinguishable, to a reader, from something the tool made
 * up.
 *
 * So `resolveChain` exists and `validateSurface` refuses a model whose ids do
 * not resolve. A traceability requirement nobody checks is a convention.
 *
 * ## Stable ids
 *
 * `api_0001` means the same endpoint across runs of the same scan, which is
 * what lets a consumer diff two weeks of scans. The ids are assigned in a
 * deterministic order by the packages that own each kind; this one only
 * carries and resolves them.
 */

export const SURFACE_SCHEMA_VERSION = "1.0.0";

/** What kind of thing a surface item is. */
export const SURFACE_KINDS = [
  "api_endpoint",
  "route",
  "form",
  "websocket",
  "webmcp_tool",
  "origin",
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * How the item came to be known.
 *
 * §24's vocabulary. `observed` means the browser saw it happen; everything
 * else is weaker and says so.
 */
export const PROVENANCES = [
  "observed",
  "correlated",
  "derived",
  "inferred",
  "candidate",
] as const;
export type Provenance = (typeof PROVENANCES)[number];

export interface SurfaceItem {
  readonly surface_id: string;
  readonly kind: SurfaceKind;
  /** `GET https://shop.example.com/api/orders/{id}` — human and machine. */
  readonly identity: string;
  readonly provenance: Provenance;

  /** The workflow this belongs to, where one was detected. */
  readonly workflow_id?: string | undefined;
  /** Its position in that workflow's sequence, 1-based. */
  readonly workflow_step?: number | undefined;
  /** The API object, for an endpoint. */
  readonly api_id?: string | undefined;
  /** The interaction that caused it, where one did. */
  readonly interaction_id?: string | undefined;
  readonly navigation_id?: string | undefined;
  /** The state before and after, where the state model saw a transition. */
  readonly state_before?: string | undefined;
  readonly state_after?: string | undefined;
  /** Which identity observed it. Never absent (§12.3 point 4). */
  readonly auth_context: string;

  /**
   * Events this resolves to. §35B.5 — a derived object without these is a bug.
   */
  readonly source_event_ids: readonly string[];
  /** Set only by M4+. Absent at Tier 0, which is not the same as empty. */
  readonly semantic?: Record<string, unknown> | undefined;
}

export interface AttackSurface {
  readonly schema_version: string;
  readonly session_id: string;
  readonly target: string;
  readonly items: readonly SurfaceItem[];
  /** §10C.6 travels with the model, not with whoever renders it. */
  readonly coverage_caveat: string;
}

export const SURFACE_CAVEAT =
  "This describes the surface reachable and observed under the target policy, " +
  "authentication state and budget in force. It is not an inventory of the " +
  "application.";

/** One link in §35B.5's chain, for `resolveChain`. */
export interface ChainLink {
  readonly level: "surface" | "workflow" | "api" | "event" | "interaction" | "navigation";
  readonly id: string;
  /** False when the id does not resolve — which §35B.5 calls a bug. */
  readonly resolved: boolean;
}

export interface ResolveInput {
  readonly knownWorkflows: ReadonlySet<string>;
  readonly knownApis: ReadonlySet<string>;
  readonly knownEvents: ReadonlySet<string>;
  readonly knownInteractions: ReadonlySet<string>;
  readonly knownNavigations: ReadonlySet<string>;
}

/**
 * Walk one item back to the observations behind it.
 *
 * Returns the whole chain including the links that failed, rather than
 * throwing on the first. A reader debugging a broken chain wants to see where
 * it broke, and a caller validating a model wants every problem at once.
 */
export function resolveChain(item: SurfaceItem, known: ResolveInput): readonly ChainLink[] {
  const chain: ChainLink[] = [{ level: "surface", id: item.surface_id, resolved: true }];

  if (item.workflow_id !== undefined) {
    chain.push({
      level: "workflow",
      id: item.workflow_id,
      resolved: known.knownWorkflows.has(item.workflow_id),
    });
  }
  if (item.api_id !== undefined) {
    chain.push({ level: "api", id: item.api_id, resolved: known.knownApis.has(item.api_id) });
  }
  for (const eventId of item.source_event_ids) {
    chain.push({ level: "event", id: eventId, resolved: known.knownEvents.has(eventId) });
  }
  if (item.interaction_id !== undefined) {
    chain.push({
      level: "interaction",
      id: item.interaction_id,
      resolved: known.knownInteractions.has(item.interaction_id),
    });
  }
  if (item.navigation_id !== undefined) {
    chain.push({
      level: "navigation",
      id: item.navigation_id,
      resolved: known.knownNavigations.has(item.navigation_id),
    });
  }

  return chain;
}

export interface SurfaceProblem {
  readonly surface_id: string;
  readonly problem: string;
}

/**
 * Check the model against its own contract.
 *
 * §35B.5's requirement, enforced rather than documented: an item with no
 * source events, or with an id that resolves to nothing, is a bug and this
 * says so by name.
 */
export function validateSurface(
  surface: AttackSurface,
  known: ResolveInput,
): readonly SurfaceProblem[] {
  const problems: SurfaceProblem[] = [];
  const seenIds = new Set<string>();

  for (const item of surface.items) {
    if (seenIds.has(item.surface_id)) {
      problems.push({ surface_id: item.surface_id, problem: "duplicate surface_id" });
    }
    seenIds.add(item.surface_id);

    if (item.source_event_ids.length === 0) {
      // §35B.5 in as many words. An item nobody can walk back to an
      // observation is indistinguishable from one the tool made up.
      problems.push({
        surface_id: item.surface_id,
        problem: "no source_event_ids — a derived object without them is a bug (§35B.5)",
      });
    }

    for (const link of resolveChain(item, known)) {
      if (link.resolved) continue;
      problems.push({
        surface_id: item.surface_id,
        problem: `${link.level} ${link.id} does not resolve`,
      });
    }

    if (item.auth_context === "") {
      problems.push({
        surface_id: item.surface_id,
        problem: "auth_context is empty — every observation knows which identity produced it",
      });
    }
  }

  return problems;
}

export interface BuildSurfaceInput {
  readonly sessionId: string;
  readonly target: string;
  readonly items: readonly Omit<SurfaceItem, "surface_id">[];
}

/**
 * Assemble the model.
 *
 * Items are sorted before ids are assigned, so `srf_0001` means the same
 * thing across two runs of the same scan — which is what lets a consumer diff
 * this week against last week. Sorting by identity rather than by discovery
 * order is deliberate: arrival order varies with what the browser did first,
 * and M1 measured that it is not stable.
 */
export function buildAttackSurface(input: BuildSurfaceInput): AttackSurface {
  const sorted = [...input.items].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.identity.localeCompare(b.identity),
  );

  return {
    schema_version: SURFACE_SCHEMA_VERSION,
    session_id: input.sessionId,
    target: input.target,
    items: sorted.map((item, index) => ({
      surface_id: `srf_${String(index + 1).padStart(4, "0")}`,
      ...item,
    })),
    coverage_caveat: SURFACE_CAVEAT,
  };
}
