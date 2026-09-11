/**
 * WebSocket and EventSource payloads — build plan §5.1, §17A; dev plan BR-M1-05.
 *
 * §5.1 names these as a capability the MCP tool surface does not expose, and
 * therefore as part of why raw CDP is the transport. A persistent connection
 * is also where a long-lived application keeps the traffic that matters most —
 * a REST scan sees the handshake and nothing after it.
 *
 * ## Observation, not classification
 *
 * §17A asks a scan to tell a keepalive from application traffic, and §32.1
 * says observation is separate from interpretation. So these payloads carry
 * the *protocol facts* that make the judgment possible — the RFC 6455 opcode,
 * the direction, whether SSE sent a comment rather than data — and take no
 * view on what any of it means. Deciding that a text frame containing `{"op":
 * "heartbeat"}` is a keepalive is BR-M1-22's job, and it can only make that
 * call if the frame was recorded in the first place.
 */

export type FrameDirection = "sent" | "received";

/** RFC 6455 §5.2 opcodes, named. */
export const WS_OPCODE_NAMES: Readonly<Record<number, string>> = {
  0x0: "continuation",
  0x1: "text",
  0x2: "binary",
  0x8: "close",
  0x9: "ping",
  0xa: "pong",
};

export interface WebSocketCreatedPayload {
  /** CDP's request id for the connection. Joins every frame to its socket. */
  readonly requestId: string;
  readonly url: string;
  /** Which script opened it, where Chrome says. */
  readonly initiator?: { readonly type: string; readonly url?: string | undefined } | undefined;
  readonly targetId: string;
}

export interface WebSocketOpenedPayload {
  readonly requestId: string;
  readonly status: number;
  readonly statusText?: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  /** Request headers as sent, which is where the cookies and subprotocol are. */
  readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
  readonly targetId: string;
}

export interface WebSocketFramePayload {
  readonly requestId: string;
  readonly direction: FrameDirection;
  readonly opcode: number;
  /** `text`, `binary`, `ping`, `pong`, `close`, `continuation`. */
  readonly opcodeName: string;
  /**
   * True for opcodes 0x8-0xf.
   *
   * A protocol fact from RFC 6455, not a classification: control frames are
   * the ones §17A can call `keepalive` without inspecting anything. An
   * application heartbeat sent as a text frame is a judgment call, and that
   * one belongs to BR-M1-22.
   */
  readonly controlFrame: boolean;
  readonly payloadBytes: number;
  /** Absent when the body policy declined it, with `skipped` saying why. */
  readonly payload?: string | undefined;
  readonly skipped?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly targetId: string;
}

export interface WebSocketClosedPayload {
  readonly requestId: string;
  /** Set when Chrome reported an error rather than a clean close. */
  readonly error?: string | undefined;
  readonly targetId: string;
}

export interface EventSourceMessagePayload {
  readonly requestId: string;
  /** SSE's `event:` field. Defaults to `message` when the stream omits it. */
  readonly eventName: string;
  /** SSE's `id:` field, which a client replays from after a reconnect. */
  readonly eventId?: string | undefined;
  readonly dataBytes: number;
  readonly data?: string | undefined;
  readonly skipped?: string | undefined;
  readonly targetId: string;
}
