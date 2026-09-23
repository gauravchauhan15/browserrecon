/**
 * The attack-surface JSON Schema — build plan §23; dev plan BR-M3-11.
 *
 * A published contract, committed to the repository rather than generated at
 * install time, because a downstream consumer must be able to read it without
 * running anything. `scripts/generate-schemas.mjs --check` in CI is what stops
 * the committed copy drifting from the types it came from.
 *
 * ## Why a version and a compatibility test
 *
 * A scanner that imports this builds against its shape. Removing a field or
 * tightening a constraint breaks that consumer silently — their parse
 * succeeds and their data is wrong, or their parse fails on the next run with
 * no explanation. So `schema-compatibility.test.ts` compares the committed
 * schema against the generated one and fails on a breaking change that did
 * not come with a major-version bump.
 *
 * Additive changes are fine and deliberately unpoliced: §35B.6 says Tier 2
 * "changes shape only additively", and a new optional field breaks nobody.
 */
import { PROVENANCES, SURFACE_KINDS, SURFACE_SCHEMA_VERSION } from "./surface.js";

const ID_PATTERN = (prefix: string): string => `^${prefix}_[0-9]{4,}$`;

export function buildAttackSurfaceSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/gauravchauhan15/browserrecon/schemas/attack-surface/attack-surface.schema.json",
    title: "BrowserRecon attack surface",
    description:
      "The unified, scanner-consumable model (build plan §23). Every item resolves " +
      "back to raw observations via source_event_ids (§35B.5).",
    "x-schema-version": SURFACE_SCHEMA_VERSION,
    type: "object",
    required: ["schema_version", "session_id", "target", "items", "coverage_caveat"],
    additionalProperties: false,
    properties: {
      schema_version: { type: "string", description: "Bumped when this shape changes." },
      session_id: { type: "string", pattern: ID_PATTERN("sess") },
      target: { type: "string", format: "uri" },
      coverage_caveat: {
        type: "string",
        minLength: 1,
        description:
          "§10C.6. Required and non-empty: a consumer must not be able to render this " +
          "model without the statement that it describes reachable surface, not the " +
          "application.",
      },
      items: {
        type: "array",
        items: { $ref: "#/$defs/surfaceItem" },
      },
    },
    $defs: {
      surfaceItem: {
        type: "object",
        required: [
          "surface_id",
          "kind",
          "identity",
          "provenance",
          "auth_context",
          "source_event_ids",
        ],
        additionalProperties: false,
        properties: {
          surface_id: { type: "string", pattern: ID_PATTERN("srf") },
          kind: { type: "string", enum: [...SURFACE_KINDS] },
          identity: { type: "string", minLength: 1 },
          provenance: { type: "string", enum: [...PROVENANCES] },
          workflow_id: { type: "string", pattern: ID_PATTERN("wf") },
          workflow_step: { type: "integer", minimum: 1 },
          api_id: { type: "string", pattern: ID_PATTERN("api") },
          interaction_id: { type: "string", pattern: ID_PATTERN("int") },
          navigation_id: { type: "string", pattern: ID_PATTERN("nav") },
          state_before: { type: "string" },
          state_after: { type: "string" },
          auth_context: {
            type: "string",
            minLength: 1,
            description:
              "§12.3 point 4. Never absent: an observation that does not know which " +
              "identity produced it cannot be compared with one that does.",
          },
          source_event_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", pattern: ID_PATTERN("evt") },
            description:
              "§35B.5. At least one, always — a derived object without resolvable " +
              "source ids is a bug, so the schema refuses an empty list rather than " +
              "leaving it to a reviewer.",
          },
          semantic: {
            type: "object",
            description:
              "Added by M4+. Absent at Tier 0, which is not the same as empty — §35B.6 " +
              "requires the deterministic content to be byte-identical between tiers.",
          },
        },
      },
    },
  };
}
