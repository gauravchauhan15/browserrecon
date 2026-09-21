/**
 * Network domain wiring — build plan §5.1, §13.1; dev plan BR-M1-03.
 *
 * Lifted out of the attach shell when BR-M1-04 added the Page and Runtime
 * domains: all three share one attachment and one emission queue, because two
 * `Target.setAutoAttach` calls on the same browser would fight — the second
 * replaces the first's settings, and only one would hear about a new target.
 */
import type { CDPSession } from "puppeteer-core";
import { shouldCaptureBody } from "./body-policy.js";
import type { TelemetryContext } from "./context.js";
import type {
  CdpHeaders,
  CdpInitiator,
  CdpStackTrace,
  ExtraInfo,
  LoadingFailed,
  LoadingFinished,
  RequestWillBeSent,
  ResponseReceived,
} from "./cdp-shapes.js";
import type {
  NetworkFailedPayload,
  NetworkRequestPayload,
  NetworkResponsePayload,
  RequestInitiator,
  ResponseBody,
} from "./types.js";

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

/** What is known about a request between its start and its end. */
interface Pending {
  readonly request: NetworkRequestPayload;
  response?: ResponseReceived["response"] | undefined;
  requestHeadersSent?: Record<string, string> | undefined;
  responseHeadersExtra?: Record<string, string> | undefined;
}

/** In-flight requests, keyed `targetId:requestId` — ids are unique per target. */
const pending = new Map<string, Pending>();

/**
 * ExtraInfo that arrived before the request it belongs to.
 *
 * `Network.requestWillBeSentExtraInfo` can arrive on either side of
 * `requestWillBeSent`, and the first version of this dropped it when it came
 * first — the pending entry did not exist yet, so `pending.get` returned
 * undefined and the headers Chrome actually sent were silently lost. It
 * surfaced as an intermittently failing test rather than an obvious bug,
 * which is the worst way for a dropped-data path to announce itself.
 */
const earlyExtraInfo = new Map<string, { request?: Record<string, string> }>();

/** Forget in-flight state. Called on detach so a new attach starts clean. */
export function resetNetworkState(): void {
  pending.clear();
  earlyExtraInfo.clear();
}

async function captureBody(
  cdp: CDPSession,
  requestId: string,
  mimeType: string | undefined,
  encodedDataLength: number | undefined,
  ctx: TelemetryContext,
): Promise<ResponseBody> {
  const decision = shouldCaptureBody({
    mimeType,
    encodedDataLength,
    bytesSoFar: ctx.counters.bodyBytes,
    limits: ctx.limits,
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
    if (bytes > ctx.limits.maxBodyBytes) {
      return { skipped: "too_large", capturedBytes: 0 };
    }

    ctx.counters.bodiesCaptured += 1;
    ctx.counters.bodyBytes += bytes;
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

export function wireNetworkDomain(
  cdp: CDPSession,
  targetId: string,
  ctx: TelemetryContext,
): void {
  cdp.on("Network.requestWillBeSent", (raw: unknown) => {
    ctx.touch();
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
    const key = `${targetId}:${event.requestId}`;
    const early = earlyExtraInfo.get(key);
    earlyExtraInfo.delete(key);
    pending.set(key, {
      request: payload,
      ...(early?.request === undefined ? {} : { requestHeadersSent: early.request }),
    });
    ctx.counters.requests += 1;

    ctx.enqueue(async () => {
      ctx.emit("network_request", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Network.requestWillBeSentExtraInfo", (raw: unknown) => {
    ctx.touch();
    const event = raw as ExtraInfo;
    const key = `${targetId}:${event.requestId}`;
    const entry = pending.get(key);
    // Either side of requestWillBeSent, so an early arrival is held rather
    // than dropped. Stored rather than emitted, and carried on the response
    // event — emitting a second event for it would double-count requests.
    if (entry === undefined) {
      earlyExtraInfo.set(key, { request: lowerHeaders(event.headers) });
      return;
    }
    entry.requestHeadersSent = lowerHeaders(event.headers);
  });

  cdp.on("Network.responseReceived", (raw: unknown) => {
    ctx.touch();
    const event = raw as ResponseReceived;
    const entry = pending.get(`${targetId}:${event.requestId}`);
    if (entry === undefined) {
      ctx.counters.orphanEvents += 1;
      return;
    }
    entry.response = event.response;
  });

  cdp.on("Network.responseReceivedExtraInfo", (raw: unknown) => {
    ctx.touch();
    const event = raw as ExtraInfo;
    const entry = pending.get(`${targetId}:${event.requestId}`);
    if (entry !== undefined) entry.responseHeadersExtra = lowerHeaders(event.headers);
  });

  cdp.on("Network.loadingFinished", (raw: unknown) => {
    ctx.touch();
    const event = raw as LoadingFinished;
    const key = `${targetId}:${event.requestId}`;
    const entry = pending.get(key);
    pending.delete(key);

    if (entry?.response === undefined) {
      // A response we never saw start. Counted, because a non-zero total at
      // the end of a scan means observation began late and the log is not
      // the complete record it claims to be.
      ctx.counters.orphanEvents += 1;
      return;
    }

    const { response } = entry;
    ctx.counters.responses += 1;

    ctx.enqueue(async () => {
      const body = await captureBody(
        cdp,
        event.requestId,
        response.mimeType,
        event.encodedDataLength ?? response.encodedDataLength,
        ctx,
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

      ctx.emit("network_response", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Network.loadingFailed", (raw: unknown) => {
    ctx.touch();
    const event = raw as LoadingFailed;
    const key = `${targetId}:${event.requestId}`;
    const entry = pending.get(key);
    pending.delete(key);
    ctx.counters.failures += 1;

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

    ctx.enqueue(async () => {
      ctx.emit("network_failed", payload);
      await Promise.resolve();
    });
  });
}
