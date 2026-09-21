/**
 * @browserrecon/exporter-json — the machine-readable export.
 *
 * Streaming, redacted, and shaped so a consumer can tell "no gaps" from "this
 * version does not report gaps". Build plan §23, §22.2, §37.2.
 */
export const PACKAGE_NAME = "@browserrecon/exporter-json" as const;

export {
  COVERAGE_CAVEAT,
  EXPORT_SCHEMA_VERSION,
  REQUIRED_KEYS,
  validateDocument,
} from "./shape.js";
export type { ExportedApi, ExportedDocument } from "./shape.js";

export { streamDocument, streamJsonl } from "./stream.js";
export type { DocumentInput, Section, Sink, StreamOptions } from "./stream.js";
