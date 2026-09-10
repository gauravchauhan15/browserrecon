/**
 * @browserrecon/event-store — Durable append-only JSONL persistence, checkpointing and streaming reads
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/event-store" as const;
