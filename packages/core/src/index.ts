/**
 * @browserrecon/core — Shared types, deterministic IDs, logging and redaction primitives
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/core" as const;

export { ID_KINDS, IdFactory, idKindOf, isId } from "./ids.js";
export type { Id, IdKind } from "./ids.js";

export { LOG_LEVELS, createLogger, silentLogger } from "./logger.js";
export type {
  LogFields,
  LogFormat,
  LogLevel,
  LogRecord,
  LogSink,
  Logger,
  LoggerOptions,
} from "./logger.js";

export { REDACTED, Redactor, createRedactor } from "./redaction.js";

export {
  BOUNDARY_RULES,
  OUTPUT_BOUNDARIES,
  OUTPUT_DIR_MODE,
  UNREDACTED_OUTPUT_WARNING,
  createSecureOutputDir,
  mayOptOut,
  requiresRedaction,
} from "./boundaries.js";
export type { BoundaryRule, OutputBoundary } from "./boundaries.js";
export type { RedactorOptions } from "./redaction.js";
