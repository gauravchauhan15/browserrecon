/**
 * @browserrecon/events — Event envelope, event-type union, provenance model and the event bus
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/events" as const;

export { EVENT_TYPES, isEventType } from "./event-types.js";
export type { EventType } from "./event-types.js";

export {
  PROVENANCE,
  isFactual,
  isModelDerived,
  isProvenance,
  isRuntimeGrounded,
} from "./provenance.js";
export type { Provenance } from "./provenance.js";

export { createEnvelope, validateEnvelope } from "./envelope.js";
export type {
  AuthContext,
  CreateEnvelopeInput,
  EnvelopeValidation,
  EnvelopeViolation,
  EventEnvelope,
} from "./envelope.js";

export { EVENT_SCHEMA_VERSION, buildEventEnvelopeSchema } from "./schema.js";
