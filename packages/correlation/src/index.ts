/**
 * @browserrecon/correlation — the classification stage.
 *
 * §17A: every network observation gets a role, using deterministic signals
 * only, and nothing is ever dropped. The role decides which consumer looks
 * at it, which is what lets a scan be re-exported under a different filter
 * without running the browser again.
 */
export const PACKAGE_NAME = "@browserrecon/correlation" as const;

export { CONSUMER_FILTERS, TRAFFIC_ROLES, classifyTraffic, passesFilter } from "./roles.js";
export type { ObservationForRole, RoleVerdict, TrafficRole } from "./roles.js";
