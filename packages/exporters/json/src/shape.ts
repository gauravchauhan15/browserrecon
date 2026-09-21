/**
 * The exported document's shape — build plan §23.1, §35B.4, §35B.5;
 * dev plan BR-M1-26.
 *
 * ## Empty is not absent
 *
 * §23.1 requires `coverage_gaps` and `unreached_candidate_associations` to be
 * present even when empty, and the reason is worth stating: a consumer that
 * finds no `coverage_gaps` key cannot tell "this scan had full coverage" from
 * "this version does not report gaps". An empty array says the first; a
 * missing key says nothing at all, and a downstream tool will guess.
 *
 * The same argument makes `schema_version` mandatory rather than
 * conditional. A document without it is a document nobody can safely parse in
 * two years.
 */

/** Bumped when the exported shape changes. Independent of the event schema. */
export const EXPORT_SCHEMA_VERSION = "1.0.0";

export interface ExportedApi {
  readonly api_id: string;
  readonly method: string;
  readonly url: string;
  readonly observed: {
    readonly status?: number | undefined;
    readonly content_type?: string | undefined;
    readonly resource_type?: string | undefined;
  };
  readonly context?:
    | {
        readonly page?: string | undefined;
        readonly workflow_id?: string | undefined;
        readonly workflow_step?: number | undefined;
        readonly navigation_id?: string | undefined;
        readonly interaction_id?: string | undefined;
      }
    | undefined;
  readonly initiator?:
    | {
        readonly type: string;
        readonly source?: string | undefined;
        readonly line?: number | undefined;
      }
    | undefined;
  readonly caused_by?: readonly string[] | undefined;
  readonly depends_on?: readonly string[] | undefined;
  /**
   * Requests observed in flight at the same time.
   *
   * §15 and §35B.4: omitting this misrepresents parallel requests as a
   * dependency chain, which is the single most misleading thing an API model
   * can do — a reader concludes B needs A when they simply both fired.
   */
  readonly parallel_with?: readonly string[] | undefined;
  /**
   * Events this object was derived from (§35B.5, §34.2).
   *
   * Every derived object carries them, and they must resolve in
   * `events.jsonl`. A model nobody can trace back to observations is a model
   * nobody can check.
   */
  readonly source_event_ids: readonly string[];
  readonly provenance: string;
}

export interface ExportedDocument {
  readonly schema_version: string;
  readonly scan: {
    readonly session_id: string;
    readonly target: string;
    readonly started_at: string;
    readonly finished_at?: string | undefined;
    readonly completeness: "complete" | "partial";
    readonly stop_reason?: string | undefined;
    readonly rate_profile: string;
    readonly discovery_sources: readonly string[];
    readonly ai_mode: string;
    /** §10C.6: never absent, so no consumer can imply complete coverage. */
    readonly coverage_caveat: string;
  };
  readonly origins: readonly {
    readonly origin: string;
    readonly requests: number;
    readonly classification: string;
  }[];
  readonly apis: readonly ExportedApi[];
  readonly workflows: readonly unknown[];
  readonly api_sequences: readonly unknown[];
  readonly javascript: readonly unknown[];
  readonly barriers: readonly unknown[];
  /** Present even when empty — see the note above. */
  readonly coverage_gaps: readonly unknown[];
  /** Present even when empty. */
  readonly unreached_candidate_associations: readonly unknown[];
}

/** The caveat §10C.6 requires on every export. */
export const COVERAGE_CAVEAT =
  "Coverage is scoped by the Target Policy, the authentication state and the scan " +
  "budget. This is what was reachable and observed, not everything that exists.";

/**
 * The keys §23.1 requires, present or empty.
 *
 * Exported so the check is one list rather than a series of assertions
 * scattered through the exporter and its tests.
 */
export const REQUIRED_KEYS: readonly (keyof ExportedDocument)[] = [
  "schema_version",
  "scan",
  "origins",
  "apis",
  "workflows",
  "api_sequences",
  "javascript",
  "barriers",
  "coverage_gaps",
  "unreached_candidate_associations",
];

/** Validate a document's shape. Returns the problems, empty when sound. */
export function validateDocument(document: Partial<ExportedDocument>): string[] {
  const problems: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (document[key] === undefined) problems.push(`missing required key: ${key}`);
  }

  if (document.schema_version !== undefined && document.schema_version === "") {
    problems.push("schema_version is present but empty");
  }
  if (document.scan !== undefined && (document.scan.coverage_caveat ?? "") === "") {
    problems.push("scan.coverage_caveat is required (§10C.6)");
  }

  for (const api of document.apis ?? []) {
    // §35B.5: a derived object with no traceable source is a claim, not an
    // observation.
    if (api.source_event_ids.length === 0) {
      problems.push(`api ${api.api_id} has no source_event_ids`);
    }
  }

  return problems;
}
