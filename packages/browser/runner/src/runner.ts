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
  type PageHarvest,
} from "@browserrecon/browser-adapter";
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
}

export interface VisitOutcome {
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

const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_DRAIN_MS = 400;

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

  let session: BrowserSession | undefined;
  let adapter: BrowserAdapter | undefined;
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

      adapter = await createBrowserAdapter({
        session,
        engine,
        logger: log,
        ...(options.navigationTimeoutMs === undefined
          ? {}
          : { defaultTimeoutMs: options.navigationTimeoutMs }),
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
        return { outcome: "visited", detail: why, discovered: [], requests: 1, forms: [] };
      }

      // Drain *after* harvesting, so requests the page made while settling
      // are published before the orchestrator moves on.
      await currentTelemetry.drain(options.drainMs ?? DEFAULT_DRAIN_MS);

      const page = harvested.value;
      for (const form of page.forms) {
        forms.push({ page: page.url, form });
      }

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
        discovered,
        requests: 1,
        forms: page.forms,
      };
    },

    close: teardown,
  };
}
