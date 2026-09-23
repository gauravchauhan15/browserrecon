/**
 * @browserrecon/state-model — a lightweight, derived state graph.
 *
 * §19: the model "does not need to be perfect in V1. It should be labelled as
 * derived and improve across versions." Every transition carries
 * `provenance: "derived"` as a literal type, so producing an observed one is
 * a compile error rather than a review comment.
 */
export const PACKAGE_NAME = "@browserrecon/state-model" as const;

export { buildStateModel, reachableFrom, resourceOf } from "./state.js";
export type {
  ApiForState,
  BuildStateInput,
  StateModel,
  StateTransition,
  StateTrigger,
} from "./state.js";
