/**
 * The CDP event shapes this package reads.
 *
 * Declared here rather than pulled from `devtools-protocol`, which ships
 * thousands of interfaces for a surface we touch a dozen of. Writing down only
 * what is consumed also documents the contract: a field absent from these
 * types is a field nothing downstream can be depending on.
 */

export interface CdpHeaders {
  readonly [name: string]: string;
}

export interface CdpCallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

export interface CdpStackTrace {
  readonly callFrames?: readonly CdpCallFrame[];
  readonly parent?: CdpStackTrace;
}

export interface CdpInitiator {
  readonly type?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly stack?: CdpStackTrace;
}

export interface RequestWillBeSent {
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

export interface ResponseReceived {
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

export interface LoadingFinished {
  readonly requestId: string;
  readonly encodedDataLength?: number;
}

export interface LoadingFailed {
  readonly requestId: string;
  readonly type?: string;
  readonly errorText: string;
  readonly canceled?: boolean;
  readonly blockedReason?: string;
  readonly corsErrorStatus?: { readonly corsError?: string };
}

export interface ExtraInfo {
  readonly requestId: string;
  readonly headers?: CdpHeaders;
}

// --- Page domain -----------------------------------------------------------

export interface CdpFrame {
  readonly id: string;
  readonly parentId?: string;
  readonly url: string;
  readonly loaderId?: string;
  readonly securityOrigin?: string;
  readonly mimeType?: string;
  /** Set when the committed URL differs from the requested one. */
  readonly urlFragment?: string;
}

export interface FrameNavigated {
  readonly frame: CdpFrame;
  /** `Navigation`, `BackForwardCacheRestore`. */
  readonly type?: string;
}

export interface FrameAttached {
  readonly frameId: string;
  readonly parentFrameId: string;
  readonly stack?: CdpStackTrace;
}

export interface FrameDetached {
  readonly frameId: string;
  readonly reason?: string;
}

export interface FrameLoading {
  readonly frameId: string;
}

/** `Page.frameRequestedNavigation` — the earliest signal of intent. */
export interface FrameRequestedNavigation {
  readonly frameId: string;
  readonly url: string;
  readonly reason?: string;
}

export interface LifecycleEvent {
  readonly frameId: string;
  readonly loaderId?: string;
  readonly name: string;
}

// --- Runtime and Debugger domains ------------------------------------------

export interface ExecutionContextCreated {
  readonly context: {
    readonly id: number;
    readonly origin?: string;
    readonly name?: string;
    readonly uniqueId?: string;
    readonly auxData?: { readonly frameId?: string; readonly isDefault?: boolean };
  };
}

export interface ExecutionContextDestroyed {
  readonly executionContextId: number;
}

export interface ScriptParsed {
  readonly scriptId: string;
  readonly url: string;
  readonly executionContextId?: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly length?: number;
  readonly hash?: string;
  readonly sourceMapURL?: string;
  readonly isModule?: boolean;
}

// --- WebSocket and EventSource --------------------------------------------

export interface WebSocketCreated {
  readonly requestId: string;
  readonly url: string;
  readonly initiator?: CdpInitiator;
}

export interface WebSocketHandshakeResponse {
  readonly requestId: string;
  readonly response: {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: CdpHeaders;
    readonly requestHeaders?: CdpHeaders;
  };
}

export interface WebSocketFrame {
  readonly requestId: string;
  readonly response: {
    /** RFC 6455 opcode. 0x9 ping and 0xa pong are the protocol keepalives. */
    readonly opcode: number;
    readonly mask?: boolean;
    readonly payloadData: string;
  };
}

export interface WebSocketClosed {
  readonly requestId: string;
}

export interface WebSocketError {
  readonly requestId: string;
  readonly errorMessage: string;
}

export interface EventSourceMessage {
  readonly requestId: string;
  readonly eventName?: string;
  readonly eventId?: string;
  readonly data: string;
}
