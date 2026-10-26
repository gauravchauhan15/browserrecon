/**
 * The browsing phase, wired up — build plan §9.3, §32.10; dev plan BR-M1-31.
 *
 * Launch a browser, attach telemetry, and visit pages under policy. This is
 * the object the orchestrator calls its `BrowsingPort`.
 *
 * ## Why it lives in `packages/browser/**`
 *
 * Because it holds a `BrowserSession`, and §32.10 says nothing outside this
 * directory may. The rule is enforced by eslint, and it caught this code
 * when it was first drafted in `apps/cli`. That is the rule working: a
 * browser handle in the CLI is a path around policy validation, since every
 * adapter method checks policy and a raw `page.goto` does not.
 *
 * The orchestrator's port types are matched *structurally* rather than
 * imported. TypeScript does the checking either way, and not importing them
 * keeps `browser/**` from depending on the layer above it.
 *
 * ## One token per page, taken before the browser is told to go
 *
 * §8.5 rule 2: the bucket is shared with discovery, and it is acquired
 * before `navigate`, not after. Acquiring afterwards would rate-limit the
 * *bookkeeping* while the requests themselves left at whatever speed Chrome
 * managed — the shape of bug that looks fine in a unit test and doubles the
 * load on a real target.
 */
import {
  createBrowserAdapter,
  type BrowserAdapter,
  type HarvestedControl,
  type PageHarvest,
} from "@browserrecon/browser-adapter";
import { buildElementReference, recordInteractions } from "@browserrecon/collector-interaction";
import {
  launchBrowser,
  type BrowserSession,
  type ChromeProbes,
} from "@browserrecon/browser-manager";
import { silentLogger, type Logger } from "@browserrecon/core";
import type { Candidate } from "@browserrecon/deterministic-explorer";
import type { EventBus } from "@browserrecon/events";
import { PolicyEngine } from "@browserrecon/policy";
import type { TargetPolicy } from "@browserrecon/policy";
import type { TokenBucket } from "@browserrecon/rate-controller";
import { decideControl, type ControlOutcome } from "./interact.js";
import { attachTelemetry, type Telemetry } from "@browserrecon/telemetry-cdp";

/** Raised when the browser itself has died, as opposed to one page failing. */
export class RunnerBrowserCrash extends Error {
  override readonly name = "BrowserCrash";
}

export interface RunnerOptions {
  readonly sessionId: string;
  readonly policy: TargetPolicy;
  readonly probes: ChromeProbes;
  readonly bus: EventBus;
  readonly executablePath?: string | undefined;
  readonly headless?: boolean | undefined;
  readonly profileRoot?: string | undefined;
  readonly logger?: Logger | undefined;
  /** How long to wait for a page to go quiet before harvesting. */
  readonly settleMs?: number | undefined;
  /** How long to wait for telemetry to publish everything it saw. */
  readonly drainMs?: number | undefined;
  readonly navigationTimeoutMs?: number | undefined;
  /**
   * Controls pressed per page.
   *
   * Bounded because a page of forty buttons would otherwise consume the
   * whole scan on one screen. Small by default: the first few controls on a
   * page are overwhelmingly the ones that do something, and §9.4's budget
   * arithmetic has to survive the multiplication.
   */
  readonly maxInteractionsPerPage?: number | undefined;
  /** Off leaves the scan navigation-only, as it was before BR-M3-pre. */
  readonly interact?: boolean | undefined;
}

export interface VisitOutcome {
  /** Controls pressed and refused on this page, with the reason for each. */
  readonly controls: readonly ControlOutcome[];
  /**
   * Whether the page was loaded. Reported rather than inferred — see the
   * note on the orchestrator's `VisitResult`.
   */
  readonly outcome: "visited" | "denied" | "failed";
  readonly detail?: string | undefined;
  readonly discovered: readonly Candidate[];
  readonly requests: number;
  /** Forms found on the page. Reported, never submitted (§7.2). */
  readonly forms: PageHarvest["forms"];
}

/** The origin of a URL, or the URL itself when it will not parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_DRAIN_MS = 400;
const DEFAULT_MAX_INTERACTIONS = 6;
/** A click's own settle budget. Shorter than a navigation's: most do little. */
const INTERACTION_SETTLE_MS = 1_000;

export interface Runner {
  launch(): Promise<void>;
  visit(context: {
    readonly candidate: Candidate;
    readonly bucket: TokenBucket;
    readonly signal?: AbortSignal | undefined;
  }): Promise<VisitOutcome>;
  close(): Promise<void>;
  /** Everything harvested, so a report can name forms it declined to submit. */
  readonly forms: readonly {
    readonly page: string;
    readonly form: PageHarvest["forms"][number];
  }[];
}

export function createRunner(options: RunnerOptions): Runner {
  const log = options.logger ?? silentLogger();
  const engine = new PolicyEngine(options.policy);
  const forms: { page: string; form: PageHarvest["forms"][number] }[] = [];
  /** Tools already reported, by origin and name. An SPA re-registers often. */
  const webmcpSeen = new Set<string>();

  let session: BrowserSession | undefined;
  let adapter: BrowserAdapter | undefined;
  /**
   * The adapter every action goes through when interacting.
   *
   * Wraps the plain adapter so each click becomes an `interaction` event on
   * the bus — which is what gives a request an `interaction_id` and makes a
   * workflow something M3 can detect rather than infer.
   */
  let recording: BrowserAdapter | undefined;
  let telemetry: Telemetry | undefined;

  const teardown = async (): Promise<void> => {
    // Order matters: detach before closing, or CDP calls race a dying
    // browser and throw on the way out of a scan that otherwise succeeded.
    await telemetry?.detach().catch(() => undefined);
    await adapter?.close().catch(() => undefined);
    await session?.close().catch(() => undefined);
    telemetry = undefined;
    adapter = undefined;
    session = undefined;
  };

  /**
   * Press what the page offers, within budget and policy.
   *
   * Re-harvests after each click rather than reusing the first read: a click
   * that opened a menu has changed the page, and pressing a selector read
   * before it would either miss or hit something else. The cost is one
   * evaluate per interaction, which is cheap next to the settle.
   */
  const pressControls = async (
    page: PageHarvest,
    pageUrl: string,
  ): Promise<ControlOutcome[]> => {
    const outcomes: ControlOutcome[] = [];
    if (options.interact === false) return outcomes;

    const driver = recording;
    if (driver === undefined) return outcomes;

    const budget = options.maxInteractionsPerPage ?? DEFAULT_MAX_INTERACTIONS;
    const pressed = new Set<string>();
    let current: readonly HarvestedControl[] = page.controls;
    let url = pageUrl;

    for (let attempt = 0; attempt < budget * 2 && pressed.size < budget; attempt += 1) {
      // Document order, always. Two scans of the same page press the same
      // buttons in the same order, or §36.2's comparison is worthless and
      // M3's workflow detection has nothing stable to detect.
      const next = current.find((control) => {
        const built = buildElementReference(control.facts);
        return !pressed.has(built.selector);
      });
      if (next === undefined) break;

      const verdict = decideControl(next, url, {
        policy: {
          allowedMethods: [...engine.policy.allowedMethods],
          stateChangingActions: engine.policy.agent.stateChangingActions,
        },
        pressed,
        remaining: budget - pressed.size,
        reference: (control) => {
          const built = buildElementReference(control.facts);
          return { selector: built.selector, label: built.label };
        },
      });

      if (!verdict.press) {
        outcomes.push({
          label: next.facts.accessibleName,
          pressed: false,
          reason: verdict.reason,
          detail: verdict.detail,
        });
        // Mark it seen so the loop moves on rather than re-deciding it.
        pressed.add(buildElementReference(next.facts).selector);
        continue;
      }

      const result = await driver.click(verdict.selector);
      pressed.add(verdict.selector);
      outcomes.push({
        selector: verdict.selector,
        label: verdict.label,
        pressed: result.status === "ok",
        ...(result.status === "ok"
          ? {}
          : { detail: result.status === "denied" ? result.reason : result.detail }),
      });

      if (result.status === "failed" && result.kind === "browser_closed") {
        throw new RunnerBrowserCrash(result.detail);
      }

      // Let whatever the click started finish before reading the page again.
      await driver.waitForSettled({ timeoutMs: INTERACTION_SETTLE_MS });

      const reharvested = await driver.harvest();
      if (reharvested.status !== "ok") break;
      current = reharvested.value.controls;
      url = reharvested.value.url;

      // A click that navigated has left the page this loop was exploring.
      // Continuing would press controls on a different screen and record
      // them against this one.
      if (url !== pageUrl && new URL(url).pathname !== new URL(pageUrl).pathname) break;
    }

    return outcomes;
  };

  return {
    get forms() {
      return forms;
    },

    async launch() {
      // A relaunch has to leave nothing behind. Without this, a crash loop
      // accumulates profile directories full of unredacted data.
      await teardown();

      session = await launchBrowser({
        sessionId: options.sessionId,
        probes: options.probes,
        ...(options.executablePath === undefined
          ? {}
          : { executablePath: options.executablePath }),
        ...(options.headless === undefined ? {} : { headless: options.headless }),
        ...(options.profileRoot === undefined ? {} : { profileRoot: options.profileRoot }),
        logger: log,
      });

      telemetry = await attachTelemetry({
        browser: session.browser,
        bus: options.bus,
        authContext: "anonymous",
        logger: log,
      });

      const created = await createBrowserAdapter({
        session,
        engine,
        logger: log,
        ...(options.navigationTimeoutMs === undefined
          ? {}
          : { defaultTimeoutMs: options.navigationTimeoutMs }),
      });
      adapter = created;
      recording = recordInteractions({
        adapter: created,
        bus: options.bus,
        authContext: "anonymous",
      });
    },

    async visit({ candidate, bucket, signal }) {
      const currentAdapter = adapter;
      const currentTelemetry = telemetry;
      if (currentAdapter === undefined || currentTelemetry === undefined) {
        throw new RunnerBrowserCrash("the browser is not running");
      }

      // Before the navigation, not after.
      await bucket.acquire();
      if (signal?.aborted === true) {
        return {
          outcome: "failed",
          detail: "cancelled",
          controls: [],
          discovered: [],
          requests: 0,
          forms: [],
        };
      }

      const navigation = await currentAdapter.navigate(candidate.url);
      if (navigation.status === "denied") {
        // Policy said no. The queue should not have offered it, so the
        // disagreement between the two checks is itself worth reporting —
        // returning an empty success here is how a scan came to claim it
        // had visited a page the browser never opened.
        log.warn("policy denied a queued URL", {
          url: candidate.url,
          reason: navigation.reason,
        });
        return {
          outcome: "denied",
          detail: navigation.reason,
          controls: [],
          discovered: [],
          requests: 0,
          forms: [],
        };
      }
      if (navigation.status === "failed") {
        if (navigation.kind === "browser_closed") {
          throw new RunnerBrowserCrash(navigation.detail);
        }
        // One page failed. The scan continues.
        return {
          outcome: "failed",
          detail: `${navigation.kind}: ${navigation.detail}`,
          controls: [],
          discovered: [],
          requests: 0,
          forms: [],
        };
      }

      // Settling is best-effort by design: a page that never goes quiet —
      // polling, a websocket, an animation — is normal, and waiting forever
      // for one is how a scan of a real application never finishes.
      await currentAdapter.waitForSettled({ timeoutMs: options.settleMs ?? DEFAULT_SETTLE_MS });

      const harvested = await currentAdapter.harvest();
      if (harvested.status === "failed" && harvested.kind === "browser_closed") {
        throw new RunnerBrowserCrash(harvested.detail);
      }
      if (harvested.status !== "ok") {
        // A page whose links could not be read is a page whose links are
        // *unknown*, not a page with none. Reading a refusal as an empty
        // result is how a scan of a four-page site reported visiting one
        // and finding nothing — silently, and with a clean exit code.
        const why =
          harvested.status === "denied"
            ? `policy refused to read the page: ${harvested.reason}`
            : `${harvested.kind}: ${harvested.detail}`;
        log.warn("could not read the page's links", { url: candidate.url, why });
        await currentTelemetry.drain(options.drainMs ?? DEFAULT_DRAIN_MS);
        return {
          outcome: "visited",
          detail: why,
          controls: [],
          discovered: [],
          requests: 1,
          forms: [],
        };
      }

      // Drain *after* harvesting, so requests the page made while settling
      // are published before the orchestrator moves on.
      await currentTelemetry.drain(options.drainMs ?? DEFAULT_DRAIN_MS);

      const page = harvested.value;
      for (const form of page.forms) {
        forms.push({ page: page.url, form });
      }

      // §45: a registry that exists but yields no tool is not the same as no
      // registry, and conflating them is exactly how a production site's four
      // tools went missing. Said out loud, once per page that does it.
      if (page.webmcpRegistriesSeen.length > 0 && page.webmcpTools.length === 0) {
        log.warn("a WebMCP registry was present but no tool could be read from it", {
          url: page.url,
          registries: page.webmcpRegistriesSeen.join(", "),
        });
      }

      // §21, §44: a registered tool is an operation the page publishes to
      // any agent that visits, and registering one sends nothing — so this
      // is the only place in the pipeline that can ever see it. Deduplicated
      // across the scan, because an SPA re-registers on every screen.
      for (const tool of page.webmcpTools) {
        const key = `${originOf(page.url)} ${tool.name}`;
        if (webmcpSeen.has(key)) continue;
        webmcpSeen.add(key);

        await options.bus.publish({
          type: "webmcp_tool_discovered",
          provenance: "observed",
          auth_context: "anonymous",
          payload: {
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
            ...(tool.endpoint === undefined ? {} : { endpoint: tool.endpoint }),
            // §7.2: `readOnlyHint: false` or `destructiveHint: true` is the
            // page telling us it publishes a destructive operation to any
            // agent that visits. That is the finding.
            ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
            origin: originOf(page.url),
            url: page.url,
            registry: tool.registry,
          },
        });
      }

      // Interact before collecting links: a click can add links to the page,
      // and harvesting again afterwards is how a code-split route is found.
      const controls = await pressControls(page, candidate.url);

      const discovered: Candidate[] = [];
      for (const link of page.links) {
        // Filtered here as well as in the queue. The queue would refuse
        // these anyway, but every refusal it records is a "we did not reach
        // this" the coverage report has to explain — and a link to
        // google.com was never in scope to begin with.
        if (engine.canVisit(link).allowed) {
          discovered.push({ url: link, source: "dom_link", depth: candidate.depth + 1 });
        }
      }

      return {
        outcome: "visited",
        controls,
        discovered,
        requests: 1,
        forms: page.forms,
      };
    },

    close: teardown,
  };
}
