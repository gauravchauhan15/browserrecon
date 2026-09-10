/**
 * @browserrecon/test-utils — Shared test harnesses.
 *
 * Test-only. Never a dependency of a runtime package.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/test-utils" as const;

export { installEgressGuard } from "./egress-guard.js";
export type { EgressAttempt, EgressGuard, EgressGuardOptions } from "./egress-guard.js";
