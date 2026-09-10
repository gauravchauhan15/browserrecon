/**
 * @browserrecon/core — Shared types, deterministic IDs, logging and redaction primitives
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/core" as const;
