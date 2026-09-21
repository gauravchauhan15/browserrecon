/**
 * @browserrecon/orchestrator — the scan lifecycle.
 *
 * Owns sequence and failure handling; owns none of the work. See
 * `orchestrator.ts` for why discovery and browsing overlap around one
 * bucket, and `phases.ts` for why only the policy phase is fatal.
 */
export const PACKAGE_NAME = "@browserrecon/orchestrator" as const;

export {
  FATAL_PHASES,
  PHASES,
  completenessFromPhases,
  isFatal,
  primaryDegradation,
} from "./phases.js";
export type { PhaseName, PhaseOutcome, PhaseStatus } from "./phases.js";

export {
  IMMUTABLE_FOR_RESUME,
  SESSION_FILE_VERSION,
  digestPolicy,
  parseSessionFile,
  writeSessionFile,
} from "./session-file.js";
export type {
  BudgetExtension,
  ImmutableSetting,
  SessionFile,
  SessionSegment,
} from "./session-file.js";

export {
  ASSIST_TIMEOUT_MS,
  HUMAN_CLEARABLE,
  decideAssist,
  runAssist,
} from "./barrier-assist.js";
export type {
  AssistContext,
  AssistDecision,
  AssistOutcome,
  AssistPrompt,
  AssistRecord,
  RunAssistInput,
} from "./barrier-assist.js";

export { BrowserCrash } from "./ports.js";
export type {
  BrowsingPort,
  Clock,
  CollectionPort,
  DiscoveryContext,
  DiscoveryPort,
  ExportInput,
  ExportPort,
  VisitContext,
  VisitResult,
} from "./ports.js";

export { STALENESS_THRESHOLD_MS, decideResume, planResume, seedFrom } from "./resume.js";
export type {
  PriorCoverage,
  ResumeAllowed,
  ResumeBudget,
  ResumeDecision,
  ResumeRefused,
  ResumeRequest,
  SeedPlan,
} from "./resume.js";

export { ScanRefused, runScan } from "./orchestrator.js";
export type { ScanInput, ScanLimits, ScanResult } from "./orchestrator.js";
