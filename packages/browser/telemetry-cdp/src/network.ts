/**
 * Runtime Telemetry over raw CDP — build plan §5.1, §13.1; dev plan BR-M1-03.
 *
 * ## Why raw CDP and not the MCP network tools
 *
 * §5.1's central decision. Chrome DevTools MCP's network tools answer "what
 * happened recently" — pollable, window-bounded, scoped to the last
 * navigation. That is the right shape for a model glancing at a page and the
 * wrong shape for an Event Store whose `caused_by` graph is only sound if
 * nothing was missed. `Network.*` gives true push subscriptions, so the
 * question "did we see every request?" has an answer instead of an estimate.
 *
 * ## Independent of whoever is driving
 *
 * Telemetry attaches to the *browser*, not to a page handed over by the
 * control layer. Every target that appears is observed, whether the
 * Deterministic Explorer caused it (V1-V4), the AI Explorer did (V5), or the
 * page opened it by itself. §5.1 requires switching drivers to change nothing
 * about what is captured, and the surest way to get that is for telemetry
 * never to be given anything by a driver.
 *
 * ## Ordering, and why emission is serialized
 *
 * CDP delivers events in order. Publishing them in order is not automatic,
 * because capturing a response body is an async round trip — two bodies
 * resolving out of order would reorder the log, and `sequence` is the ordering
 * authority the correlation engine trusts (§13.2). So emissions are chained
 * onto a single promise: each event's turn comes after the previous one has
 * finished, async work included. A slow body fetch delays the log rather than
 * shuffling it, which is the right trade when completeness is the point.
 */
import type { Browser, CDPSession } from "puppeteer-core";
import { silentLogger, type Logger } from "@browserrecon/core";
import type { EventBus } from "@browserrecon/events";
import {
  DEFAULT_BODY_LIMITS,
  shouldCaptureBody,
  type BodyCaptureLimits,
} from "./body-policy.js";
import type {
  NetworkFailedPayload,
  NetworkRequestPayload,
  NetworkResponsePayload,
  RequestInitiator,
  ResponseBody,
  TelemetryStats,
} from "./types.js";

/** CDP shapes, declared locally rather than pulled from a protocol package. */
interface CdpHeaders {
  readonly [name: string]: string;
}

interface CdpCallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

interface CdpStackTrace {
  readonly callFrames?: readonly CdpCallFrame[];
  readonly parent?: CdpStackTrace;
}

interface CdpInitiator {
  readonly type?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly stack?: CdpStackTrace;
}

interface RequestWillBeSent {
  readonly requestId: string;
  readonly frameId?: string;
  readonly documentURL?: string;
  readonly type?: string;
  readonly initiator?: CdpInitiator;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers?: CdpHeaders;
    readonly postData?: string;
    readonly hasPostData?: boolean;
  };
}

interface ResponseReceived {
  readonly requestId: string;
  readonly type?: string;
  readonly response: {
    readonly url: string;
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: CdpHeaders;
    readonly mimeType?: string;
    readonly remoteIPAddress?: string;
    readonly remotePort?: number;
    readonly protocol?: string;
    readonly fromDiskCache?: boolean;
    readonly fromServiceWorker?: boolean;
    readonly encodedDataLength?: number;
  };
}

interface LoadingFinished {
  readonly requestId: string;
  readonly encodedDataLength?: number;
}

interface LoadingFailed {
  readonly requestId: string;
  readonly type?: string;
  readonly errorText: string;
  readonly canceled?: boolean;
  readonly blockedReason?: string;
  readonly corsErrorStatus?: { readonly corsError?: string };
}

interface ExtraInfo {
  readonly requestId: string;
  readonly headers?: CdpHeaders;
}

/** Flatten a CDP stack into `function@url:line:col`, innermost first. */
function flattenStack(stack: CdpStackTrace | undefined, depth = 0): string[] {
  if (stack === undefined || depth > 4) return [];
  const frames = (stack.callFrames ?? []).map(
    (frame) =>
      `${frame.functionName === "" || frame.functionName === undefined ? "(anonymous)" : frame.functionName}` +
      `@${frame.url ?? "<unknown>"}:${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0}`,
  );
  return [...frames, ...flattenStack(stack.parent, depth + 1)];
}

function toInitiator(initiator: CdpInitiator | undefined): RequestInitiator {
  const stack = flattenStack(initiator?.stack);
  return {
    type: initiator?.type ?? "other",
    ...(initiator?.url === undefined ? {} : { url: initiator.url }),
    ...(initiator?.lineNumber === undefined ? {} : { lineNumber: initiator.lineNumber }),
    ...(initiator?.columnNumber === undefined ? {} : { columnNumber: initiator.columnNumber }),
    ...(stack.length === 0 ? {} : { stack }),
  };
}

function lowerHeaders(headers: CdpHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

export interface NetworkTelemetryOptions {
  readonly browser: Browser;
  readonly bus: EventBus;
  /** Recorded on every event; §12.3 makes it mandatory, never inferred. */
  readonly authContext?: string | undefined;
  readonly bodyLimits?: Partial<BodyCaptureLimits> | undefined;
  readonly logger?: Logger | undefined;
}

export interface NetworkTelemetry {
  readonly stats: TelemetryStats;
  /**
   * Wait until the browser has gone quiet and everything seen is published.
   *
   * Draining the internal queue alone is not enough and would be a misleading
   * promise: it flushes what has *arrived*, while Chrome may still be about to
   * report a `loadingFinished` for a request that completed a millisecond ago.
   * So this waits for a quiet period with no new CDP event first. It is a
   * settle, not a guarantee — nothing can promise the browser is finished —
   * and `quietMs` is the caller's judgment about how long counts as idle.
   */
  drain(quietMs?: number): Promise<void>;
  /** Stop observing. Detaches from every target and leaves the browser alone. */
  detach(): Promise<void>;
}

/** What is known about a request between its start and its end. */
interface Pending {
  readonly request: NetworkRequestPayload;
  response?: ResponseReceived["response"] | undefined;
  requestHeadersSent?: Record<string, string> | undefined;
  responseHeadersExtra?: Record<string, string> | undefined;
}

export async function attachNetworkTelemetry(
  options: NetworkTelemetryOptions,
): Promise<NetworkTelemetry> {
  const log = options.logger ?? silentLogger();
  const authContext = options.authContext ?? "anonymous";
  const limits: BodyCaptureLimits = { ...DEFAULT_BODY_LIMITS, ...options.bodyLimits };

  const pending = new Map<string, Pending>();
  const sessions = new Map<string, CDPSession>();

  let requests = 0;
  let responses = 0;
  let failures = 0;
  let bodiesCaptured = 0;
  let bodyBytes = 0;
  let orphanEvents = 0;
  let detached = false;
  /** When the last CDP event arrived, for `drain`'s quiet-period check. */
  let lastEventAt = Date.now();

  // The ordering guarantee, in one variable. Every emission appends to this
  // chain, so publication order is arrival order even when an emission has to
  // await a body fetch on the way.
  //
  // Honest note on how well this is tested: removing the chain did NOT fail
  // the ordering test, because CDP answers `getResponseBody` in order over one
  // connection, so the promises happen to resolve in order anyway. This is
  // therefore defensive rather than load-bearing today — it stops holding the
  // moment an emission does work with variable latency, such as writing a body
  // to a store. The test asserts publish order against an independent CDP
  // witness, so it would catch a real reordering however it arose.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((error: unknown) => {
      // A telemetry failure must not take down a scan that is otherwise
      // collecting good data (§22): the store already holds everything
      // published so far, and losing one event is better than losing the run.
      log.warn("telemetry event dropped", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  };

  async function captureBody(
    cdp: CDPSession,
    requestId: string,
    mimeType: string | undefined,
    encodedDataLength: number | undefined,
  ): Promise<ResponseBody> {
    const decision = shouldCaptureBody({
      mimeType,
      encodedDataLength,
      bytesSoFar: bodyBytes,
      limits,
    });
    if (!decision.capture) {
      return { skipped: decision.reason };
    }

    try {
      const result = (await cdp.send("Network.getResponseBody", { requestId })) as {
        body: string;
        base64Encoded: boolean;
      };

      // Chrome's encodedDataLength is the compressed size; the decoded body can
      // still overshoot the cap, so it is checked again after the fetch.
      const bytes = Buffer.byteLength(result.body, result.base64Encoded ? "base64" : "utf8");
      if (bytes > limits.maxBodyBytes) {
        return { skipped: "too_large", capturedBytes: 0 };
      }

      bodiesCaptured += 1;
      bodyBytes += bytes;
      return {
        text: result.body,
        base64Encoded: result.base64Encoded,
        capturedBytes: bytes,
        truncated: false,
      };
    } catch {
      // Chrome discards bodies it no longer holds — a cancelled request, a
      // redirect, a body already evicted. Not a failure of the scan, and
      // recorded as an absence with a reason rather than a missing field.
      return { skipped: "unavailable" };
    }
  }

  function wire(cdp: CDPSession, targetId: string): void {
    cdp.on("Network.requestWillBeSent", (raw: unknown) => {
      lastEventAt = Date.now();
      const event = raw as RequestWillBeSent;
      const payload: NetworkRequestPayload = {
        requestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        headers: lowerHeaders(event.request.headers),
        ...(event.type === undefined ? {} : { resourceType: event.type }),
        initiator: toInitiator(event.initiator),
        ...(event.documentURL === undefined ? {} : { documentUrl: event.documentURL }),
        ...(event.frameId === undefined ? {} : { frameId: event.frameId }),
        ...(event.request.postData === undefined ? {} : { postData: event.request.postData }),
        hasPostData: event.request.hasPostData === true || event.request.postData !== undefined,
        targetId,
      };

      // Keyed per target as well as request id: ids are only unique within a
      // target, and two pages can collide.
      pending.set(`${targetId}:${event.requestId}`, { request: payload });
      requests += 1;

      enqueue(async () => {
        await options.bus.publish({
          type: "network_request",
          provenance: "observed",
          auth_context: authContext,
          payload,
        });
      });
    });

    cdp.on("Network.requestWillBeSentExtraInfo", (raw: unknown) => {
      lastEventAt = Date.now();
      const event = raw as ExtraInfo;
      const entry = pending.get(`${targetId}:${event.requestId}`);
      // Arrives either side of requestWillBeSent. Stored rather than emitted,
      // and carried on the response event, where it is guaranteed to be
      // present — emitting a second event for it would double-count requests.
      if (entry !== undefined) entry.requestHeadersSent = lowerHeaders(event.headers);
    });

    cdp.on("Network.responseReceived", (raw: unknown) => {
      lastEventAt = Date.now();
      const event = raw as ResponseReceived;
      const entry = pending.get(`${targetId}:${event.requestId}`);
      if (entry === undefined) {
        orphanEvents += 1;
        return;
      }
      entry.response = event.response;
    });

    cdp.on("Network.responseReceivedExtraInfo", (raw: unknown) => {
      lastEventAt = Date.now();
      const event = raw as ExtraInfo;
      const entry = pending.get(`${targetId}:${event.requestId}`);
      if (entry !== undefined) entry.responseHeadersExtra = lowerHeaders(event.headers);
    });

    cdp.on("Network.loadingFinished", (raw: unknown) => {
      lastEventAt = Date.now();
      const event = raw as LoadingFinished;
      const key = `${targetId}:${event.requestId}`;
      const entry = pending.get(key);
      pending.delete(key);

      if (entry?.response === undefined) {
        // A response we never saw start. Counted, because a non-zero total at
        // the end of a scan means observation began late and the log is not
        // the complete record it claims to be.
        orphanEvents += 1;
        return;
      }

      const { response } = entry;
      responses += 1;

      enqueue(async () => {
        const body = await captureBody(
          cdp,
          event.requestId,
          response.mimeType,
          event.encodedDataLength ?? response.encodedDataLength,
        );

        const payload: NetworkResponsePayload = {
          requestId: event.requestId,
          url: response.url,
          status: response.status,
          ...(response.statusText === undefined ? {} : { statusText: response.statusText }),
          headers: lowerHeaders(response.headers),
          ...(response.mimeType === undefined ? {} : { mimeType: response.mimeType }),
          ...(response.remoteIPAddress === undefined
            ? {}
            : { remoteIpAddress: response.remoteIPAddress }),
          ...(response.remotePort === undefined ? {} : { remotePort: response.remotePort }),
          ...(response.protocol === undefined ? {} : { protocol: response.protocol }),
          ...(response.fromDiskCache === undefined
            ? {}
            : { fromDiskCache: response.fromDiskCache }),
          ...(response.fromServiceWorker === undefined
            ? {}
            : { fromServiceWorker: response.fromServiceWorker }),
          ...(event.encodedDataLength === undefined
            ? {}
            : { encodedDataLength: event.encodedDataLength }),
          ...(entry.requestHeadersSent === undefined
            ? {}
            : { requestHeadersSent: entry.requestHeadersSent }),
          ...(entry.responseHeadersExtra === undefined
            ? {}
            : { responseHeadersExtra: entry.responseHeadersExtra }),
          body,
          targetId,
        };

        await options.bus.publish({
          type: "network_response",
          provenance: "observed",
          auth_context: authContext,
          payload,
        });
      });
    });

    cdp.on("Network.loadingFailed", (raw: unknown) => {
      lastEventAt = Date.now();
      const event = raw as LoadingFailed;
      const key = `${targetId}:${event.requestId}`;
      const entry = pending.get(key);
      pending.delete(key);
      failures += 1;

      const payload: NetworkFailedPayload = {
        requestId: event.requestId,
        ...(entry === undefined ? {} : { url: entry.request.url }),
        errorText: event.errorText,
        canceled: event.canceled === true,
        ...(event.blockedReason === undefined ? {} : { blockedReason: event.blockedReason }),
        ...(event.corsErrorStatus?.corsError === undefined
          ? {}
          : { corsErrorStatus: event.corsErrorStatus.corsError }),
        ...(event.type === undefined ? {} : { resourceType: event.type }),
        targetId,
      };

      enqueue(async () => {
        await options.bus.publish({
          type: "network_failed",
          provenance: "observed",
          auth_context: authContext,
          payload,
        });
      });
    });
  }

  /**
   * Attach to every target, present and future, without a gap.
   *
   * The obvious approach — listen for puppeteer's `targetcreated`, then create
   * a session and enable Network — has a race that loses events: those steps
   * are async, and a page that navigates immediately is already fetching
   * before the domain is on. Measured, not theorised: a page opened and
   * navigated in the same tick lost its document, its script and its favicon.
   *
   * `Target.setAutoAttach` with `waitForDebuggerOnStart` closes it properly.
   * Chrome pauses each new target until we say go, so `Network.enable` is
   * guaranteed to be in place before the target runs a single line. That is
   * the difference between "we saw most of it" and the completeness this whole
   * boundary exists to provide (§5.1).
   */
  const root = await options.browser.target().createCDPSession();

  const onAttached = (raw: unknown): void => {
    const event = raw as {
      sessionId: string;
      targetInfo: { targetId: string; type: string };
    };
    if (detached) return;

    const child = root.connection()?.session(event.sessionId);
    if (child === null || child === undefined) {
      log.warn("no CDP session for an attached target", { type: event.targetInfo.type });
      return;
    }

    // Workers and pages both issue requests; devtools frontends and the
    // browser target itself have no traffic worth modelling.
    const watched =
      event.targetInfo.type === "page" || event.targetInfo.type.includes("worker");

    void (async () => {
      try {
        if (watched) {
          sessions.set(event.targetInfo.targetId, child);
          wire(child, event.targetInfo.targetId);
          await child.send("Network.enable");
        }
      } catch (error) {
        log.warn("could not enable telemetry on a target", {
          type: event.targetInfo.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Always released, even on failure. A target left paused is a tab
        // that never loads, which looks like the tool hanging.
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
        requests,
        responses,
        failures,
        bodiesCaptured,
        bodyBytes,
        orphanEvents,
        attachedTargets: sessions.size,
      };
    },
    drain: async (quietMs = 250) => {
      // Wait for the browser to stop reporting, bounded so a page that polls
      // forever cannot hang the caller.
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
      pending.clear();
    },
  };
}
