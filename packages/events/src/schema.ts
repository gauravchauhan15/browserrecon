/**
 * JSON Schema for the event envelope — build plan §23 (schemas are a public
 * API and must be versioned).
 *
 * Built from the same `EVENT_TYPES` and `PROVENANCE` constants the TypeScript
 * types are derived from, so the enums have exactly one source. The generated
 * file is committed under `schemas/`, and a test asserts the committed copy
 * matches this function's output — so schema drift fails CI rather than
 * reaching a downstream consumer.
 */
import { ID_KINDS } from "@browserrecon/core";
import { EVENT_TYPES } from "./event-types.js";
import { PROVENANCE } from "./provenance.js";

/**
 * Schema version for the event envelope specifically, independent of the
 * scan output's `schema_version` (§23).
 *
 * Compatibility policy: additive fields are a minor bump; removing or
 * retyping a field is a major bump.
 */
// 1.1.0 — added the `script_parsed` event type (BR-M1-04). Additive: a
// consumer that does not know the type ignores it, which is why this is a
// minor bump rather than a major one.
export const EVENT_SCHEMA_VERSION = "1.1.0";

const idPattern = (kind: keyof typeof ID_KINDS): string => {
  const { prefix, width } = ID_KINDS[kind];
  return `^${prefix}_\\d{${width},}$`;
};

/** The envelope's JSON Schema, as a plain object. */
export function buildEventEnvelopeSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/gauravchauhan15/browserrecon/schemas/events/event-envelope.schema.json",
    title: "BrowserRecon event envelope",
    description:
      "Common envelope carried by every BrowserRecon observation (build plan §13.2). " +
      "Ordering authority is `sequence`, not `timestamp`.",
    "x-schema-version": EVENT_SCHEMA_VERSION,
    type: "object",
    required: [
      "event_id",
      "session_id",
      "timestamp",
      "sequence",
      "type",
      "provenance",
      "auth_context",
      "payload",
    ],
    additionalProperties: false,
    properties: {
      event_id: {
        type: "string",
        pattern: idPattern("event"),
        description: "Deterministic, monotonic per session. Never a random UUID.",
      },
      session_id: { type: "string", pattern: idPattern("session") },
      timestamp: {
        type: "string",
        format: "date-time",
        description: "ISO 8601 UTC. Informational — use `sequence` for ordering.",
      },
      sequence: {
        type: "integer",
        minimum: 1,
        description: "Strictly increasing and gapless within a session.",
      },
      type: {
        type: "string",
        enum: [...EVENT_TYPES],
        description: "Build plan §13.1. Authoritative list.",
      },
      provenance: {
        type: "string",
        enum: [...PROVENANCE],
        description:
          "Build plan §24. `static_context_inferred` sits outside the main chain " +
          "and is always weaker than `inferred`.",
      },
      auth_context: {
        type: "string",
        minLength: 1,
        description:
          'Auth profile active when captured, or "anonymous" (§12.3). Required so ' +
          "coverage can distinguish a public route from one seen while logged out.",
      },
      page_id: { type: "string", pattern: idPattern("page") },
      navigation_id: { type: "string", pattern: idPattern("navigation") },
      workflow_id: {
        type: "string",
        pattern: idPattern("workflow"),
        description: "Assigned after correlation, so usually absent at capture time.",
      },
      payload: {
        description: "Type-specific body. Required even when empty.",
      },
    },
  };
}
