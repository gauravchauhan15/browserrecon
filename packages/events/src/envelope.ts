/**
 * Common event envelope — build plan §13.2.
 *
 * Every observation shares this shape. The envelope is what makes replay,
 * correlation, debugging and schema migration possible: a consumer can order,
 * filter and attribute any event without understanding its payload.
 */
import { isId } from "@browserrecon/core";
import { isEventType, type EventType } from "./event-types.js";
import { isProvenance, type Provenance } from "./provenance.js";

/**
 * Which authentication state produced an observation — build plan §12.3.
 *
 * Present on every event because it is what lets coverage distinguish "this
 * route is genuinely public" from "we happened to be logged out when we hit
 * it", and what makes multi-role differential coverage (§12.4) and V6's
 * authorization reasoning (§28) meaningful at all.
 *
 * `"anonymous"` for an unauthenticated session; otherwise the auth profile
 * name.
 */
export type AuthContext = string;

/** The envelope carried by every event. */
export interface EventEnvelope<TPayload = unknown> {
  /** Deterministic, monotonic per session, e.g. `evt_000042`. */
  readonly event_id: string;
  readonly session_id: string;
  /** ISO 8601, millisecond precision. Ordering uses `sequence`, not this. */
  readonly timestamp: string;
  /**
   * Strictly increasing within a session, gapless.
   *
   * This — not the timestamp — is the ordering authority: two events can
   * share a millisecond, and §15 forbids inferring causality from timing
   * anyway.
   */
  readonly sequence: number;
  readonly type: EventType;
  readonly provenance: Provenance;
  /** Which auth state was active (§12.3). */
  readonly auth_context: AuthContext;

  /** Page context, where the event belongs to one. */
  readonly page_id?: string;
  readonly navigation_id?: string;
  /** Assigned by the workflow engine after correlation, so often absent at capture. */
  readonly workflow_id?: string;

  readonly payload: TPayload;
}

/** A validation failure, naming the field and why it was rejected. */
export interface EnvelopeViolation {
  readonly field: string;
  readonly reason: string;
}

export type EnvelopeValidation =
  | { readonly ok: true; readonly envelope: EventEnvelope }
  | { readonly ok: false; readonly violations: readonly EnvelopeViolation[] };

export interface CreateEnvelopeInput<TPayload> {
  readonly event_id: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly type: EventType;
  readonly provenance: Provenance;
  readonly auth_context: AuthContext;
  readonly payload: TPayload;
  readonly timestamp?: string;
  readonly page_id?: string;
  readonly navigation_id?: string;
  readonly workflow_id?: string;
}

/**
 * Build an envelope, omitting absent optional context entirely rather than
 * setting it to `undefined` — an explicit `"page_id": null` in a JSONL line
 * would be a claim that the event had no page, when the truth is that it had
 * no page *context*.
 */
export function createEnvelope<TPayload>(
  input: CreateEnvelopeInput<TPayload>,
): EventEnvelope<TPayload> {
  return {
    event_id: input.event_id,
    session_id: input.session_id,
    timestamp: input.timestamp ?? new Date().toISOString(),
    sequence: input.sequence,
    type: input.type,
    provenance: input.provenance,
    auth_context: input.auth_context,
    ...(input.page_id === undefined ? {} : { page_id: input.page_id }),
    ...(input.navigation_id === undefined ? {} : { navigation_id: input.navigation_id }),
    ...(input.workflow_id === undefined ? {} : { workflow_id: input.workflow_id }),
    payload: input.payload,
  };
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Validate an untrusted envelope — a line read back from a stored log, or one
 * produced by a resumed session.
 *
 * Collects every violation rather than failing on the first, so a corrupt log
 * line reports everything wrong with it in one pass instead of one problem
 * per re-run.
 */
export function validateEnvelope(value: unknown): EnvelopeValidation {
  const violations: EnvelopeViolation[] = [];
  const reject = (field: string, reason: string): void =>
    void violations.push({ field, reason });

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, violations: [{ field: "(root)", reason: "expected an object" }] };
  }

  const raw = value as Record<string, unknown>;

  if (!isId(raw.event_id, "event")) {
    reject("event_id", "expected a well-formed event id such as evt_000001");
  }
  if (!isId(raw.session_id, "session")) {
    reject("session_id", "expected a well-formed session id such as sess_0001");
  }
  if (typeof raw.timestamp !== "string" || !ISO_8601.test(raw.timestamp)) {
    reject("timestamp", "expected ISO 8601 UTC with optional milliseconds");
  }
  if (typeof raw.sequence !== "number" || !Number.isInteger(raw.sequence) || raw.sequence < 1) {
    reject("sequence", "expected a positive integer");
  }
  if (!isEventType(raw.type)) {
    reject("type", "not a known event type (build plan §13.1)");
  }
  if (!isProvenance(raw.provenance)) {
    reject("provenance", "not a known provenance value (build plan §24)");
  }
  if (typeof raw.auth_context !== "string" || raw.auth_context.length === 0) {
    reject("auth_context", 'expected a non-empty string, "anonymous" when unauthenticated');
  }
  if (!("payload" in raw)) {
    reject("payload", "required, even when empty");
  }

  for (const [field, kind] of [
    ["page_id", "page"],
    ["navigation_id", "navigation"],
    ["workflow_id", "workflow"],
  ] as const) {
    const present = raw[field];
    if (present !== undefined && !isId(present, kind)) {
      reject(field, `present but not a well-formed ${kind} id`);
    }
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, envelope: raw as unknown as EventEnvelope };
}
