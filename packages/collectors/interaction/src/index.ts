/**
 * @browserrecon/collector-interaction — every explorer action, recorded.
 *
 * Wraps a `BrowserAdapter` so each action becomes an `interaction` event with
 * a stable element reference, which is what lets the requests that follow be
 * attributed to it (§14). Build plan §13.1, §14; dev plan BR-M1-08.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/collector-interaction" as const;

export { recordInteractions } from "./collector.js";
export type {
  Interaction,
  InteractionKind,
  InteractionModel,
  InteractionPayload,
  RecordOptions,
  RecordingAdapter,
} from "./collector.js";

export {
  GENERATED_ID_RULES,
  REFERENCE_STRATEGIES,
  buildElementReference,
  isStableId,
  renderGeneratedIdTable,
} from "./element-ref.js";
export type { ElementReference, ReferenceStability, ReferenceStrategy } from "./element-ref.js";
