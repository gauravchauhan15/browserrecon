/**
 * @browserrecon/telemetry-cdp — the observation boundary.
 *
 * Subscribes to raw CDP `Network.*`, `Page.*`, `Runtime.*` and `Debugger.*`
 * events for every browser target and normalizes them into envelope events.
 * Build plan §5.1, §13.1, §16; dev plan BR-M1-03, BR-M1-04.
 *
 * Independent of whatever is driving the browser (§5.1): telemetry attaches to
 * the browser and observes every target that appears, so switching from the
 * Deterministic Explorer to the AI Explorer changes what happens, never what
 * is captured.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/telemetry-cdp" as const;

export { attachTelemetry } from "./telemetry.js";
export type { Telemetry, TelemetryOptions } from "./telemetry.js";

export {
  BODY_CAPTURE_RULES,
  DEFAULT_BODY_LIMITS,
  renderCaptureTable,
  shouldCaptureBody,
} from "./body-policy.js";
export type {
  BodyCaptureLimits,
  CaptureDecision,
  CaptureInput,
  SkipReason,
} from "./body-policy.js";

export type { PageDomainOptions } from "./page-domain.js";

export type {
  ExecutionContextPayload,
  FrameRef,
  NavigationCommittedPayload,
  NavigationStartedPayload,
  PageLoadedPayload,
  ScriptParsedPayload,
} from "./page-types.js";

export type {
  NetworkFailedPayload,
  NetworkRequestPayload,
  NetworkResponsePayload,
  RequestInitiator,
  ResponseBody,
  TelemetryStats,
} from "./types.js";
