/**
 * @browserrecon/fixtures — Deterministic local fixture applications for tests
 *
 * Local applications a scan can be pointed at without touching the internet.
 * Every response is fixed: no clocks, no randomness, no external calls, so
 * §36.2's golden-output comparisons mean something.
 *
 * Public API only. Internals stay unexported; consumers may not deep-import
 * (enforced by eslint, dev plan §2.4).
 */

/** Package identity, used by diagnostics and the `doctor` command. */
export const PACKAGE_NAME = "@browserrecon/fixtures" as const;

export { startFixture, withFixture } from "./harness.js";
export type { RunningFixture, StartFixtureOptions } from "./harness.js";

export type {
  FixtureApp,
  FixtureHandler,
  FixtureRequest,
  FixtureResponse,
  FixtureRoute,
  FixtureState,
  RecordedRequest,
} from "./types.js";

export { staticSite } from "./apps/static-site.js";
export { restApi } from "./apps/rest-api.js";
export { framedSite } from "./apps/framed-site.js";
export { spaSite } from "./apps/spa-site.js";
export { WS_CLIENT_MESSAGES, WS_GREETING, realtimeSite } from "./apps/realtime-site.js";
export { BURST_ALLOWANCE, THROTTLE_DURATION, throttledApi } from "./apps/throttled-api.js";
export { formsSite } from "./apps/forms-site.js";
export { dynamicSite } from "./apps/dynamic-site.js";
export { BEACON_PATHS, FIRST_PARTY_API, VENDOR_SCRIPTS, noisySite } from "./apps/noisy-site.js";
export type { NoisySiteOptions } from "./apps/noisy-site.js";
export { WEBMCP_TOOLS, webmcpSite } from "./apps/webmcp-site.js";
export { WEBMCP_MAP_TOOLS, webmcpMapSite } from "./apps/webmcp-map-site.js";
export { ORDER_ID, PARALLEL_PATHS, parallelSite } from "./apps/parallel-site.js";

export { OPCODES, decodeFrame, encodeFrame, handshakeAccept } from "./websocket.js";
export type { FixtureSocket, WebSocketRoute } from "./websocket.js";

import { dynamicSite } from "./apps/dynamic-site.js";
import { formsSite } from "./apps/forms-site.js";
import { framedSite } from "./apps/framed-site.js";
import { noisySite } from "./apps/noisy-site.js";
import { parallelSite } from "./apps/parallel-site.js";
import { realtimeSite } from "./apps/realtime-site.js";
import { spaSite } from "./apps/spa-site.js";
import { restApi } from "./apps/rest-api.js";
import { staticSite } from "./apps/static-site.js";
import { throttledApi } from "./apps/throttled-api.js";
import { webmcpSite } from "./apps/webmcp-site.js";
import { webmcpMapSite } from "./apps/webmcp-map-site.js";
import type { FixtureApp } from "./types.js";

/**
 * Every fixture app, for tests that must hold across all of them — the
 * determinism and no-egress guarantees in particular.
 *
 * Listing them here rather than in each test is what makes those guarantees
 * apply to fixtures added later by default: a new app added to this array is
 * immediately subject to them, instead of being exempt until someone
 * remembers to extend a test.
 */
export const ALL_FIXTURE_APPS: readonly (() => FixtureApp)[] = [
  staticSite,
  restApi,
  framedSite,
  realtimeSite,
  spaSite,
  throttledApi,
  formsSite,
  dynamicSite,
  noisySite,
  webmcpSite,
  webmcpMapSite,
  parallelSite,
];
