/**
 * Streaming reader — build plan §22.2 (growth control), dev plan §1.2.
 *
 * Two hard requirements shape this.
 *
 * **Never load the log into memory.** A large scan produces a multi-gigabyte
 * event log, and `pnpm export` has to work on it. Reading is line-by-line
 * throughout, so memory is a function of the longest line rather than of the
 * file.
 *
 * **Tolerate a truncated tail.** If the process died mid-write, the last line
 * is half a JSON object. That is not corruption to be thrown at the caller —
 * it is the expected shape of an interrupted scan, and everything before it is
 * perfectly good evidence. Refusing to read such a log would throw away the
 * data the durability design exists to protect.
 *
 * This module is also what makes dev plan §1.2 work: correlation and
 * everything rightward run against a recorded log with no browser present, so
 * the pipeline is replayable and testable offline.
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { validateEnvelope, type EventEnvelope } from "@browserrecon/events";
import { BodyStore, isExternalBodyRef, type ExternalBodyRef } from "./bodies.js";
import { sessionPaths } from "./layout.js";
import type { Manifest } from "./store.js";

/** A line that could not be used, and why. */
export interface ReadProblem {
  readonly segment: string;
  /** 1-indexed line number within the segment. */
  readonly line: number;
  readonly kind: "truncated_tail" | "malformed_json" | "invalid_envelope";
  readonly detail: string;
}

export interface ReadOptions {
  /**
   * Called for each unusable line instead of throwing.
   *
   * Default is to ignore, because an interrupted scan's trailing partial line
   * is normal and a caller that only wants events should not have to care.
   */
  readonly onProblem?: ((problem: ReadProblem) => void) | undefined;
  /** Skip events at or below this sequence. Used by `resume` (§30). */
  readonly afterSequence?: number | undefined;
  /**
   * Read externalized payloads back from the body store (§22.2).
   *
   * Off by default, because the streaming reader exists so memory is a
   * function of the longest line rather than of the log, and resolving every
   * reference gives that up.
   *
   * On for anything that analyses payloads. §22.2 externalizes the *whole*
   * payload, not just its body — so an event over the threshold reaches a
   * consumer with no url, no mime type and no body, and silently contributes
   * nothing. A scan of the reference application externalized its eight largest responses,
   * `the main entry bundle` among them, and the static pass read the 113 small
   * chunks and none of the bundles the application actually lives in.
   */
  readonly resolveExternal?: boolean | undefined;
}

/** Read the segment manifest, if one exists. */
export function readManifest(dir: string): Manifest | undefined {
  const path = sessionPaths(dir).manifest;
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stream every event in a session, in sequence order.
 *
 * Segments are visited in manifest order. When the manifest is missing or
 * unreadable — an interrupted scan may never have written one — segment files
 * are discovered and sorted by name, which the zero-padded naming makes
 * equivalent to numeric order. Losing the manifest must not lose the log.
 */
export async function* readEvents(
  dir: string,
  options: ReadOptions = {},
): AsyncGenerator<EventEnvelope> {
  const paths = sessionPaths(dir);
  const manifest = readManifest(dir);

  const segments =
    manifest !== undefined && manifest.segments.length > 0
      ? [...manifest.segments].sort((a, b) => a.ordinal - b.ordinal).map((s) => s.filename)
      : discoverSegments(dir);

  const after = options.afterSequence ?? 0;
  const bodies = options.resolveExternal === true ? new BodyStore(paths.bodies) : undefined;

  for (const filename of segments) {
    const path = join(paths.dir, filename);
    if (!existsSync(path)) continue;

    let lineNumber = 0;
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const raw of lines) {
        lineNumber++;
        if (raw.trim() === "") continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // A partial object can only be the last line of a file: everything
          // before it was terminated by the newline readline split on.
          options.onProblem?.({
            segment: filename,
            line: lineNumber,
            kind: raw.endsWith("}") ? "malformed_json" : "truncated_tail",
            detail: `${raw.length} bytes could not be parsed`,
          });
          continue;
        }

        const validation = validateEnvelope(parsed);
        if (!validation.ok) {
          options.onProblem?.({
            segment: filename,
            line: lineNumber,
            kind: "invalid_envelope",
            detail: validation.violations.map((v) => `${v.field}: ${v.reason}`).join("; "),
          });
          continue;
        }

        if (validation.envelope.sequence <= after) continue;

        if (bodies !== undefined && isExternalBodyRef(validation.envelope.payload)) {
          // A missing or unreadable body file must not end the read. The
          // reference stays in place, which is what a consumer already has to
          // tolerate, rather than losing every event after it.
          try {
            const payload = await bodies.get(validation.envelope.payload);
            yield { ...validation.envelope, payload };
            continue;
          } catch (error) {
            options.onProblem?.({
              segment: filename,
              line: lineNumber,
              kind: "malformed_json",
              detail: `externalized payload ${validation.envelope.payload.hash} could not be read: ${String(error)}`,
            });
          }
        }

        yield validation.envelope;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}

/** Segment filenames on disk, in order, when the manifest is unavailable. */
function discoverSegments(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => /^events-\d{4,}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** Collect a session's events into an array. Small logs and tests only. */
export async function readAllEvents(
  dir: string,
  options: ReadOptions = {},
): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  for await (const event of readEvents(dir, options)) events.push(event);
  return events;
}

/** Whether an event's payload was externalized (§22.2). */
export function payloadIsExternal(
  envelope: EventEnvelope,
): envelope is EventEnvelope<ExternalBodyRef> {
  return isExternalBodyRef(envelope.payload);
}
