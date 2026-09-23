/**
 * @browserrecon/attack-surface — the scanner-consumable model.
 *
 * §35B.5 is the requirement this package exists to keep: "any claim in
 * report.md can be walked back to the raw observations that produced it. A
 * derived object without resolvable source IDs is a bug." So the chain is
 * resolvable, and `validateSurface` refuses a model where it is not.
 */
export const PACKAGE_NAME = "@browserrecon/attack-surface" as const;

export {
  PROVENANCES,
  SURFACE_CAVEAT,
  SURFACE_KINDS,
  SURFACE_SCHEMA_VERSION,
  buildAttackSurface,
  resolveChain,
  validateSurface,
} from "./surface.js";
export type {
  AttackSurface,
  BuildSurfaceInput,
  ChainLink,
  Provenance,
  ResolveInput,
  SurfaceItem,
  SurfaceKind,
  SurfaceProblem,
} from "./surface.js";

export { buildAttackSurfaceSchema } from "./schema.js";
