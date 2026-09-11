/**
 * Event type union — build plan §13.1.
 *
 * This list is **authoritative**. If any part of the plan says an occurrence
 * is "recorded", it must map to a type here; if it does not, this list is
 * wrong and gets extended, rather than the behaviour going unrecorded.
 *
 * That rule exists because it was violated once: eleven types (template
 * saturation, JS parse failures, liveness probes, re-authentication, human
 * assists) were described as recorded in later plan sections while being
 * absent here — behaviour with nowhere to persist it.
 *
 * Grouping is documentation; the union is flat.
 */
export const EVENT_TYPES = [
  // Lifecycle
  "scan_started",
  "scan_finished",
  "browser_started",
  "browser_stopped",

  // Navigation and page (§16)
  "page_loaded",
  "navigation_started",
  "navigation_committed",
  "soft_navigation",

  // Interaction (§5A drives these; §13.1 records them)
  "interaction",

  // Network (§5.1 — from CDP event subscriptions, not polling)
  "network_request",
  "network_response",
  "network_failed",
  // Persistent connections (dev plan BR-M1-05). §5.1 names WebSocket frames as
  // a capability the MCP tool surface does not expose, and a long-lived
  // application keeps the traffic that matters most here — a REST-shaped scan
  // sees the handshake and nothing after it.
  "websocket_created",
  "websocket_opened",
  "websocket_frame",
  "websocket_closed",
  "eventsource_message",

  // Runtime
  "console_message",
  "js_execution_context",
  // A script the page parsed, from Debugger.scriptParsed — distinct from the
  // network events, which see files. This sees scripts: inline blocks, eval,
  // new Function, anything a bundler injects at runtime. §10A has nothing to
  // mine for those unless they are inventoried (dev plan BR-M1-04).
  "script_parsed",
  "storage_observation",
  "cookie_observation",

  // Discovery (§9.4, §9.5.3, §10D.1)
  "discovery_imported",
  "template_saturated",
  "template_divergence",

  // JavaScript analysis (§10B.9 — a parser failure is an event, not a scan failure)
  "js_analysis_completed",
  "js_analysis_failed",

  // Coverage (§10C.5, §10C.7)
  "coverage_gap_identified",
  "liveness_probe_result",

  // Authentication (§12.3)
  "auth_state_changed",

  // WebMCP (§21)
  "webmcp_tool_discovered",
  "webmcp_tool_invoked",
  "webmcp_tool_result",

  // Artifacts
  "screenshot_captured",
  "dom_snapshot",

  // Derived model (§18, §19)
  "state_change",
  "workflow_started",
  "workflow_updated",
  "workflow_finished",

  // Agent (V5+, §27)
  "agent_decision",
  "agent_action",

  // Operational (§8.4, §8.6, §10C.7)
  "access_barrier",
  "rate_limit",
  "human_assist_requested",
  "human_assist_completed",
  "error",
] as const;

/**
 * Every observation is one of these. Unknown types are rejected at compile
 * time, which is the point: a new kind of observation forces a deliberate
 * edit here and to the JSON Schema, rather than arriving as a loose string.
 */
export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Narrow an untrusted value to an EventType. Used when reading a stored log. */
export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}
