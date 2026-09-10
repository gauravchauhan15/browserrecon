/**
 * @browserrecon/event-store — durable append-only JSONL persistence.
 *
 * §22 calls this the source of truth: every other component can fail and be
 * restarted, but what is written here is what the scan actually observed.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/event-store" as const;

export { EventStore } from "./store.js";
export type {
  Checkpoint,
  EventStoreOptions,
  EventStoreStats,
  Manifest,
  SegmentRecord,
} from "./store.js";

export { readAllEvents, readEvents, readManifest, payloadIsExternal } from "./reader.js";
export type { ReadOptions, ReadProblem } from "./reader.js";

export { BodyStore, isExternalBodyRef } from "./bodies.js";
export type { ExternalBodyRef } from "./bodies.js";

export { LAYOUT, segmentName, segmentOrdinal, sessionPaths } from "./layout.js";
export type { SessionPaths } from "./layout.js";
