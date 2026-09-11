/**
 * The attachment shell — build plan §5.1; dev plan BR-M1-03, BR-M1-04.
 *
 * One attachment, shared by every domain. Two `Target.setAutoAttach` calls on
 * the same browser would fight: the second replaces the first's settings, and
 * only one of them would ever hear about a new target. So this owns the root
 * session, the emission queue, the counters and the quiet-period clock, and
 * hands each domain a context.
 *
 * ## Attaching without a gap
 *
 * The obvious approach — listen for puppeteer's `targetcreated`, then create a
 * session and enable the domains — has a race that loses events, measured
 * rather than theorised: a page created and navigated in the same tick lost
 * its document, its script and its favicon, because every step is async and
 * the page was already fetching.
 *
 * `waitForDebuggerOnStart` closes it at the protocol level. Chrome pauses each
 * new target until we release it, so every domain is enabled before the target
 * runs a line.
 *
 * ## Attached to the browser, never handed a page
 *
 * §5.1 requires switching drivers to change nothing about what is captured.
 * The surest way to get that is for telemetry never to be given anything by a
 * driver: it watches the browser, and a tab the *site* opens for itself is
 * observed exactly like one the explorer opened.
 */
import type { Browser, CDPSession } from "puppeteer-core";
import { silentLogger, type Logger } from "@browserrecon/core";
import type { EventBus, EventType } from "@browserrecon/events";
import { DEFAULT_BODY_LIMITS, type BodyCaptureLimits } from "./body-policy.js";
import { newCounters, type EventIds, type TelemetryContext } from "./context.js";
import { resetNetworkState, wireNetworkDomain } from "./network-domain.js";
import {
  enablePageDomains,
  newPageDomainState,
  wirePageDomain,
  type PageDomainOptions,
} from "./page-domain.js";
import type { TelemetryStats } from "./types.js";

export interface TelemetryOptions extends PageDomainOptions {
  readonly browser: Browser;
  readonly bus: EventBus;
  /** Recorded on every event; §12.3 makes it mandatory, never inferred. */
  readonly authContext?: string | undefined;
  readonly bodyLimits?: Partial<BodyCaptureLimits> | undefined;
  readonly logger?: Logger | undefined;
  /** Watch `Network.*`. On by default. */
  readonly network?: boolean | undefined;
  /** Watch `Page.*`, `Runtime.*` and `Debugger.*`. On by default. */
  readonly pageAndRuntime?: boolean | undefined;
}

export interface Telemetry {
  readonly stats: TelemetryStats;
  /**
   * Wait until the browser has gone quiet and everything seen is published.
   *
   * Draining the internal queue alone would promise more than it delivers:
   * Chrome may still be about to report a `loadingFinished` for a request that
   * completed a millisecond ago. So this waits for a quiet period with no new
   * CDP event first. It is a settle, not a guarantee — nothing can promise the
   * browser is finished — and `quietMs` is the caller's judgment about how
   * long counts as idle.
   */
  drain(quietMs?: number): Promise<void>;
  /** Stop observing. Detaches from every target and leaves the browser alone. */
  detach(): Promise<void>;
}

export async function attachTelemetry(options: TelemetryOptions): Promise<Telemetry> {
  const log = options.logger ?? silentLogger();
  const counters = newCounters();
  const sessions = new Map<string, CDPSession>();
  const pageState = newPageDomainState();

  let detached = false;
  let lastEventAt = Date.now();

  // The ordering guarantee, in one variable. Every emission appends to this
  // chain, so publication order is arrival order even when an emission has to
  // await a body fetch on the way — and navigations order against the requests
  // they caused, which arrive on a different domain.
  //
  // Honest note: removing the chain did NOT fail the ordering test, because
  // CDP answers `getResponseBody` in order over one connection so the promises
  // happen to resolve in order anyway. This is therefore defensive rather than
  // load-bearing today; it stops holding the moment an emission does work with
  // variable latency, such as writing a body to a store.
  let queue: Promise<void> = Promise.resolve();

  const ctx: TelemetryContext = {
    bus: options.bus,
    authContext: options.authContext ?? "anonymous",
    log,
    limits: { ...DEFAULT_BODY_LIMITS, ...options.bodyLimits },
    counters,
    enqueue: (work) => {
      queue = queue.then(work).catch((error: unknown) => {
        // A telemetry failure must not take down a scan that is otherwise
        // collecting good data (§22): the store already holds everything
        // published so far, and losing one event beats losing the run.
        log.warn("telemetry event dropped", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    },
    touch: () => {
      lastEventAt = Date.now();
    },
    emit: (type: EventType, payload: unknown, ids?: EventIds) => {
      void options.bus.publish({
        type,
        provenance: "observed",
        auth_context: ctx.authContext,
        payload,
        ...(ids?.page_id === undefined ? {} : { page_id: ids.page_id }),
        ...(ids?.navigation_id === undefined ? {} : { navigation_id: ids.navigation_id }),
      });
    },
  };

  const root = await options.browser.target().createCDPSession();

  const onAttached = (raw: unknown): void => {
    const event = raw as { sessionId: string; targetInfo: { targetId: string; type: string } };
    if (detached) return;

    const child = root.connection()?.session(event.sessionId);
    if (child === null || child === undefined) {
      log.warn("no CDP session for an attached target", { type: event.targetInfo.type });
      return;
    }

    // Pages and workers issue requests and run scripts; devtools frontends and
    // the browser target itself have nothing worth modelling.
    const watched =
      event.targetInfo.type === "page" || event.targetInfo.type.includes("worker");

    void (async () => {
      try {
        if (watched) {
          sessions.set(event.targetInfo.targetId, child);

          if (options.network !== false) {
            wireNetworkDomain(child, event.targetInfo.targetId, ctx);
            await child.send("Network.enable");
          }
          if (options.pageAndRuntime !== false) {
            wirePageDomain(child, event.targetInfo.targetId, ctx, pageState);
            // Workers have no Page domain; failing to enable it there must not
            // cost us the Runtime and Debugger domains, which they do have.
            await enablePageDomains(child, options, pageState).catch((error: unknown) => {
              log.debug("page domains unavailable on this target", {
                type: event.targetInfo.type,
                reason: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
      } catch (error) {
        log.warn("could not enable telemetry on a target", {
          type: event.targetInfo.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Always released, even on failure. A target left paused is a tab that
        // never loads, which looks like the tool hanging.
        await child.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
      }
    })();
  };

  root.on("Target.attachedToTarget", onAttached);
  await root.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  return {
    get stats(): TelemetryStats {
      return {
        requests: counters.requests,
        responses: counters.responses,
        failures: counters.failures,
        bodiesCaptured: counters.bodiesCaptured,
        bodyBytes: counters.bodyBytes,
        orphanEvents: counters.orphanEvents,
        navigations: counters.navigations,
        frames: pageState.frames.size,
        liveExecutionContexts: pageState.contexts.size,
        scripts: counters.scripts,
        attachedTargets: sessions.size,
      };
    },
    drain: async (quietMs = 250) => {
      // Bounded, so a page that polls forever cannot hang the caller.
      const deadline = Date.now() + 10_000;
      while (Date.now() - lastEventAt < quietMs && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, quietMs));
      }
      // Two passes: the first drains what is queued now, the second catches
      // anything those emissions themselves enqueued.
      await queue;
      await queue;
      await options.bus.drain();
    },
    detach: async () => {
      detached = true;
      root.off("Target.attachedToTarget", onAttached);
      await root
        .send("Target.setAutoAttach", {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
        .catch(() => undefined);
      await queue;
      for (const cdp of sessions.values()) {
        try {
          await cdp.detach();
        } catch {
          // The target may already be gone; the browser owns that lifetime.
        }
      }
      sessions.clear();
      pageState.frames.clear();
      pageState.contexts.clear();
      resetNetworkState();
    },
  };
}
