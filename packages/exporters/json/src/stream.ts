/**
 * Streaming export — build plan §22.2 (growth control), §23; dev plan BR-M1-26.
 *
 * §22.2 is explicit that `browserrecon export` must work by streaming and
 * never by loading the full event log into memory. A gigabyte event log on a
 * large scan is the normal case, not the pathological one, and an exporter
 * that builds the whole document in memory first fails exactly on the scans
 * whose results matter most.
 *
 * So the document is written in pieces: the scalar header first, then each
 * array streamed element by element. The cost is that the writer has to know
 * the key order, which is why `REQUIRED_KEYS` exists rather than each call
 * site choosing.
 */
import type { Redactor } from "@browserrecon/core";
import { COVERAGE_CAVEAT, EXPORT_SCHEMA_VERSION, type ExportedDocument } from "./shape.js";

/** Somewhere to write to. A file handle, a socket, or a string in a test. */
export type Sink = (chunk: string) => void | Promise<void>;

export interface StreamOptions {
  /**
   * Applied to every value on the way out.
   *
   * Required rather than optional: §37.2 puts exports on the redacted side of
   * the boundary, and an optional redactor is one a caller forgets. Passing
   * an explicitly permissive one is a visible decision in a diff.
   */
  readonly redactor: Redactor;
  /** Pretty-print. Off by default — an export is usually read by a machine. */
  readonly pretty?: boolean | undefined;
}

/** A section that can produce its elements lazily. */
export type Section<T> = Iterable<T> | AsyncIterable<T>;

export interface DocumentInput {
  readonly scan: ExportedDocument["scan"];
  readonly origins: Section<unknown>;
  readonly apis: Section<unknown>;
  readonly workflows: Section<unknown>;
  readonly apiSequences: Section<unknown>;
  readonly javascript: Section<unknown>;
  readonly barriers: Section<unknown>;
  readonly coverageGaps: Section<unknown>;
  readonly unreachedCandidateAssociations: Section<unknown>;
}

/**
 * Write the document to a sink, one element at a time.
 *
 * Every array is emitted even when it yields nothing, because §23.1 requires
 * the keys to exist — an absent `coverage_gaps` cannot be told apart from
 * full coverage.
 */
export async function streamDocument(
  input: DocumentInput,
  sink: Sink,
  options: StreamOptions,
): Promise<void> {
  const nl = options.pretty === true ? "\n" : "";
  const indent = options.pretty === true ? "  " : "";

  const write = async (chunk: string): Promise<void> => {
    await sink(chunk);
  };

  const encode = (value: unknown): string =>
    JSON.stringify(options.redactor.redact(value), null, options.pretty === true ? 2 : 0);

  await write(`{${nl}`);
  await write(`${indent}"schema_version":${JSON.stringify(EXPORT_SCHEMA_VERSION)},${nl}`);
  await write(
    `${indent}"scan":${encode({ ...input.scan, coverage_caveat: COVERAGE_CAVEAT })},${nl}`,
  );

  const sections: [string, Section<unknown>][] = [
    ["origins", input.origins],
    ["apis", input.apis],
    ["workflows", input.workflows],
    ["api_sequences", input.apiSequences],
    ["javascript", input.javascript],
    ["barriers", input.barriers],
    ["coverage_gaps", input.coverageGaps],
    ["unreached_candidate_associations", input.unreachedCandidateAssociations],
  ];

  for (const [index, [name, section]] of sections.entries()) {
    await write(`${indent}${JSON.stringify(name)}:[`);
    let first = true;
    for await (const element of section as AsyncIterable<unknown>) {
      if (!first) await write(",");
      first = false;
      await write(encode(element));
    }
    await write(`]${index === sections.length - 1 ? "" : ","}${nl}`);
  }

  await write("}");
}

/**
 * Write one JSONL record per element.
 *
 * The format a pipeline actually wants: `jq` over a stream, no bracket
 * matching, and a partial file from an interrupted export is still valid
 * input for everything before the cut.
 */
export async function streamJsonl(
  records: Section<unknown>,
  sink: Sink,
  options: StreamOptions,
): Promise<number> {
  let written = 0;
  for await (const record of records as AsyncIterable<unknown>) {
    await sink(`${JSON.stringify(options.redactor.redact(record))}\n`);
    written += 1;
  }
  return written;
}
