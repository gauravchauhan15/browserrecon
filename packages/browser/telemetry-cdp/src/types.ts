/**
 * Network event payloads — build plan §13.1, §13.2; dev plan BR-M1-03.
 *
 * The shapes the Correlation Engine, the API model and every exporter read.
 * They are close to CDP's own vocabulary on purpose: this layer normalizes
 * names and drops driver objects, but it does not interpret. §32.1 —
 * observation is separate from interpretation — means a decision made here
 * about what something *is* cannot be revisited later, because the evidence
 * for it was never written down.
 */

/** Where a request came from. Chrome supplies this; it is not inferred. */
export interface RequestInitiator {
  /** CDP's own vocabulary: `parser`, `script`, `preload`, `SignedExchange`, `preflight`, `other`. */
  readonly type: string;
  /** Script or document that caused it, where Chrome names one. */
  readonly url?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly columnNumber?: number | undefined;
  /**
   * Call frames, innermost first, flattened to `function@url:line:col`.
   *
   * Kept as strings rather than CDP's nested stack structure because the
   * consumers of this are a correlation rule and a human reading a report,
   * and neither benefits from reconstructing the tree.
   */
  readonly stack?: readonly string[] | undefined;
}

export interface NetworkRequestPayload {
  /** CDP's request id. The join key for everything below. */
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** CDP's resource type: `Document`, `XHR`, `Fetch`, `Script`, `Image`, … */
  readonly resourceType?: string | undefined;
  readonly initiator: RequestInitiator;
  /** The document this was issued from, for attributing a request to a page. */
  readonly documentUrl?: string | undefined;
  readonly frameId?: string | undefined;
  /** Present when the request carried one. Raw — the store is evidence (§37.2). */
  readonly postData?: string | undefined;
  readonly hasPostData: boolean;
  /** Which target this came from, so a worker's traffic is distinguishable. */
  readonly targetId: string;
}

export interface ResponseBody {
  /** Absent when policy said metadata-only, with `skipped` saying why. */
  readonly text?: string | undefined;
  readonly base64Encoded?: boolean | undefined;
  /** Why no body was captured: `policy`, `too_large`, `budget_exhausted`, `unavailable`. */
  readonly skipped?: string | undefined;
  /** Bytes actually captured, after any truncation. */
  readonly capturedBytes?: number | undefined;
  /** True when the body was cut short at the per-body cap. */
  readonly truncated?: boolean | undefined;
}

export interface NetworkResponsePayload {
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly statusText?: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly mimeType?: string | undefined;
  /**
   * The address Chrome actually connected to.
   *
   * The Policy Engine cannot prevent DNS rebinding — it resolves a hostname,
   * and Chrome connects separately moments later. Its own note says the
   * durable mitigation is post-hoc detection here. So this field exists to
   * make that mismatch visible after the fact, and dropping it would quietly
   * remove the only evidence of it.
   */
  readonly remoteIpAddress?: string | undefined;
  readonly remotePort?: number | undefined;
  readonly protocol?: string | undefined;
  readonly fromDiskCache?: boolean | undefined;
  readonly fromServiceWorker?: boolean | undefined;
  readonly encodedDataLength?: number | undefined;
  /**
   * Request headers as they actually went on the wire.
   *
   * `Network.requestWillBeSent` reports what the page asked for;
   * `requestWillBeSentExtraInfo` reports what Chrome sent, including cookies
   * and headers added by the network stack. For a recon tool the difference is
   * the point, so both are recorded rather than one being treated as the truth.
   */
  readonly requestHeadersSent?: Readonly<Record<string, string>> | undefined;
  /** `Set-Cookie` and friends, which `responseReceived` omits. */
  readonly responseHeadersExtra?: Readonly<Record<string, string>> | undefined;
  readonly body?: ResponseBody | undefined;
  readonly targetId: string;
}

export interface NetworkFailedPayload {
  readonly requestId: string;
  readonly url?: string | undefined;
  readonly errorText: string;
  readonly canceled: boolean;
  /** Set when Chrome itself blocked it — CSP, mixed content, an extension. */
  readonly blockedReason?: string | undefined;
  readonly corsErrorStatus?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly targetId: string;
}

export interface TelemetryStats {
  readonly requests: number;
  readonly responses: number;
  readonly failures: number;
  /** Responses whose body was fetched. */
  readonly bodiesCaptured: number;
  /** Bytes of response body held across the scan, against the budget. */
  readonly bodyBytes: number;
  /**
   * Events for a request id never seen starting.
   *
   * Almost always a request already in flight when telemetry attached. Counted
   * rather than dropped, because a non-zero value at the end of a scan means
   * observation started late and the log is not complete.
   */
  readonly orphanEvents: number;
  readonly navigations: number;
  /** Frames currently attached across every watched target. */
  readonly frames: number;
  /**
   * Execution contexts currently alive.
   *
   * A count that only grows across navigations means stale ids are leaking,
   * and every script after that point is attributed to a context that no
   * longer exists.
   */
  readonly liveExecutionContexts: number;
  /** Distinct scripts inventoried, including inline and eval-ed ones. */
  readonly scripts: number;
  /** WebSocket connections opened. */
  readonly webSockets: number;
  /** Frames seen in both directions, control frames included. */
  readonly webSocketFrames: number;
  readonly eventSourceMessages: number;
  /** CDP targets currently being watched. */
  readonly attachedTargets: number;
}
