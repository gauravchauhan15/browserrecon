/**
 * @browserrecon/collector-dom — bounded DOM snapshots.
 *
 * Links, forms and resource references, captured at navigation boundaries and
 * size-capped with every omission recorded. Build plan §13.1, §41; dev plan
 * BR-M1-09.
 */
export const PACKAGE_NAME = "@browserrecon/collector-dom" as const;

export { DEFAULT_SNAPSHOT_LIMITS, applyLimits, hasCredentialField } from "./snapshot.js";
export type {
  DomSnapshot,
  FieldRef,
  FormRef,
  LinkRef,
  ResourceRef,
  SnapshotLimits,
} from "./snapshot.js";
