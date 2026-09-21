/**
 * @browserrecon/deterministic-explorer — the rule-based driver (§5A).
 *
 * The component that makes the browser act in V1–V4. Without it, "isolated
 * Chrome session" has no mechanism for producing navigation or interaction
 * signal before V5's AI Explorer exists — the collectors would have nothing
 * to collect.
 *
 * Every decision it makes is a pure function over stable inputs, exported
 * separately: the visit order (`queue.ts`), whether a form may be submitted
 * (`forms.ts`), and when to stop (`budget.ts`). That split is what makes
 * §5A.5's determinism requirement testable as arithmetic rather than by
 * running a scan twice and hoping.
 */
export const PACKAGE_NAME = "@browserrecon/deterministic-explorer" as const;

export { DISCOVERY_SOURCES, SKIP_REASONS, compareCandidates, createQueue } from "./queue.js";
export type {
  Candidate,
  DiscoverySource,
  QueueOptions,
  SkipReason,
  Skipped,
  VisitQueue,
} from "./queue.js";

export { normalizeIdentity } from "./identity.js";

export { FORM_CLASSES, classifyForm, decideSubmission, synthesizeValue } from "./forms.js";
export type { FormClass, FormFacts, FormVerdict, PolicyView } from "./forms.js";

export {
  STOP_REASONS,
  completenessFor,
  computeEffectiveBudget,
  createBudgetTracker,
} from "./budget.js";
export type {
  BindingConstraint,
  Budget,
  BudgetTracker,
  Completeness,
  EffectiveBudget,
  StopReason,
  TrackerOptions,
} from "./budget.js";
