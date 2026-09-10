/**
 * Session artifact layout — build plan §22.2.
 *
 * One directory per scan session. Everything a scan produces lives under it,
 * which is what makes a session self-contained enough to hand to `resume`
 * (§30) or to archive.
 *
 * The directory holds **unredacted** captured data by design (§37.2) — cookies,
 * tokens, authorization headers, request bodies. Redaction happens at the
 * boundaries that leave the machine. Callers create it with restrictive
 * permissions for that reason, and `.gitignore` excludes it.
 */
import { join } from "node:path";

/** File and directory names inside a session directory. */
export const LAYOUT = {
  /** Session metadata, including the §7.4 authorization record. */
  session: "session.json",
  /** Durability marker: how far the log is known to be safely on disk. */
  checkpoint: "checkpoint.json",
  /** Ordered list of event-log segments. */
  manifest: "segments.json",
  /** Event log segments live here, named `events-0001.jsonl`. */
  segments: ".",
  /** Payloads too large to inline, addressed by content hash. */
  bodies: "bodies",
  /** Screenshots, sampled at workflow boundaries (§41). */
  screenshots: "screenshots",
} as const;

/** Name of the nth segment. Zero-padded so lexical order matches numeric. */
export function segmentName(ordinal: number): string {
  return `events-${String(ordinal).padStart(4, "0")}.jsonl`;
}

/** Parse a segment ordinal back out of its filename. */
export function segmentOrdinal(filename: string): number | undefined {
  const match = /^events-(\d{4,})\.jsonl$/.exec(filename);
  if (match === null) return undefined;
  const ordinal = Number(match[1]);
  return Number.isInteger(ordinal) ? ordinal : undefined;
}

/** Absolute paths within a session directory. */
export function sessionPaths(dir: string) {
  return {
    dir,
    session: join(dir, LAYOUT.session),
    checkpoint: join(dir, LAYOUT.checkpoint),
    manifest: join(dir, LAYOUT.manifest),
    bodies: join(dir, LAYOUT.bodies),
    screenshots: join(dir, LAYOUT.screenshots),
    segment: (ordinal: number): string => join(dir, segmentName(ordinal)),
  };
}

export type SessionPaths = ReturnType<typeof sessionPaths>;
