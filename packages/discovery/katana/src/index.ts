/**
 * @browserrecon/discovery-katana — the Katana adapter.
 *
 * Katana supplies breadth; our instrumented Chrome supplies runtime depth
 * (§5A.3). A URL Katana found is an *imported* observation, not a runtime
 * one, and §9.4 keeps that distinction in the provenance.
 *
 * Katana being absent, crashing or timing out is a **capability limitation,
 * never a scan failure** (§8.5 rule 3). Browser-native discovery is always on
 * and produces a useful scan by itself.
 */
export const PACKAGE_NAME = "@browserrecon/discovery-katana" as const;

export { buildKatanaArgv, rateFromArgv } from "./argv.js";
export type { KatanaArgvInput, KatanaLimits } from "./argv.js";

export { parseKatanaJsonl } from "./parse.js";
export type { KatanaResult, ParseOutcome } from "./parse.js";
