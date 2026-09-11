/**
 * WebSocket and EventSource wiring — build plan §5.1, §17A; dev plan BR-M1-05.
 *
 * Shares the attachment, the emission queue and the counters with every other
 * domain (telemetry.ts), so a frame orders correctly against the navigation
 * and the requests around it.
 *
 * ## Frame payloads are capped, not free
 *
 * A chat application can push thousands of frames a minute. Keeping every
 * payload would swamp the event log for the same reason wholesale body capture
 * would, so frames go through the same §41 budget as response bodies — with
 * one deliberate difference: a frame's payload is always *considered*, because
 * unlike a font or a video there is no such thing as a WebSocket frame whose
 * content is knowably uninteresting. The cap does the filtering, not a content
 * type.
 *
 * A skipped payload still produces an event. The shape of a conversation —
 * how many frames, which direction, how big, in what order — is most of what
 * makes it a workflow, and it survives even when the contents do not.
 */
import type { CDPSession } from "puppeteer-core";
import type { TelemetryContext } from "./context.js";
import type {
  EventSourceMessage,
  WebSocketClosed,
  WebSocketCreated,
  WebSocketError,
  WebSocketFrame,
  WebSocketHandshakeResponse,
} from "./cdp-shapes.js";
import {
  WS_OPCODE_NAMES,
  type EventSourceMessagePayload,
  type FrameDirection,
  type WebSocketClosedPayload,
  type WebSocketCreatedPayload,
  type WebSocketFramePayload,
  type WebSocketOpenedPayload,
} from "./realtime-types.js";

/** Opcodes 0x8-0xf are control frames (RFC 6455 §5.5). */
const CONTROL_FRAME_FLOOR = 0x8;

function lowerHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

/**
 * Decide what to keep of a payload.
 *
 * Returns the text, or a reason it was left out. The per-scan budget is shared
 * with response bodies on purpose: a scan's total appetite for captured
 * content is one number, and splitting it would let a chatty socket quietly
 * double it.
 */
function capture(
  text: string,
  ctx: TelemetryContext,
): { payload?: string; skipped?: string; truncated?: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");

  if (!ctx.limits.enabled) return { skipped: "disabled", bytes };
  if (ctx.counters.bodyBytes >= ctx.limits.maxTotalBytes) {
    return { skipped: "budget_exhausted", bytes };
  }
  if (bytes > ctx.limits.maxBodyBytes) {
    return { skipped: "too_large", bytes };
  }

  ctx.counters.bodyBytes += bytes;
  return { payload: text, truncated: false, bytes };
}

export function wireRealtimeDomain(
  cdp: CDPSession,
  targetId: string,
  ctx: TelemetryContext,
): void {
  const emitFrame = (direction: FrameDirection) => (raw: unknown) => {
    ctx.touch();
    const event = raw as WebSocketFrame;
    const opcode = event.response.opcode;
    const kept = capture(event.response.payloadData, ctx);
    ctx.counters.webSocketFrames += 1;

    const payload: WebSocketFramePayload = {
      requestId: event.requestId,
      direction,
      opcode,
      opcodeName: WS_OPCODE_NAMES[opcode] ?? `unknown_${opcode}`,
      controlFrame: opcode >= CONTROL_FRAME_FLOOR,
      payloadBytes: kept.bytes,
      ...(kept.payload === undefined ? {} : { payload: kept.payload }),
      ...(kept.skipped === undefined ? {} : { skipped: kept.skipped }),
      ...(kept.truncated === undefined ? {} : { truncated: kept.truncated }),
      targetId,
    };

    ctx.enqueue(async () => {
      ctx.emit("websocket_frame", payload);
      await Promise.resolve();
    });
  };

  cdp.on("Network.webSocketCreated", (raw: unknown) => {
    ctx.touch();
    const event = raw as WebSocketCreated;
    ctx.counters.webSockets += 1;

    const payload: WebSocketCreatedPayload = {
      requestId: event.requestId,
      url: event.url,
      ...(event.initiator?.type === undefined
        ? {}
        : {
            initiator: {
              type: event.initiator.type,
              ...(event.initiator.url === undefined ? {} : { url: event.initiator.url }),
            },
          }),
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("websocket_created", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Network.webSocketHandshakeResponseReceived", (raw: unknown) => {
    ctx.touch();
    const event = raw as WebSocketHandshakeResponse;

    const payload: WebSocketOpenedPayload = {
      requestId: event.requestId,
      status: event.response.status,
      ...(event.response.statusText === undefined
        ? {}
        : { statusText: event.response.statusText }),
      headers: lowerHeaders(event.response.headers),
      ...(event.response.requestHeaders === undefined
        ? {}
        : { requestHeaders: lowerHeaders(event.response.requestHeaders) }),
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("websocket_opened", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Network.webSocketFrameSent", emitFrame("sent"));
  cdp.on("Network.webSocketFrameReceived", emitFrame("received"));

  cdp.on("Network.webSocketFrameError", (raw: unknown) => {
    ctx.touch();
    const event = raw as WebSocketError;
    const payload: WebSocketClosedPayload = {
      requestId: event.requestId,
      error: event.errorMessage,
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("websocket_closed", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Network.webSocketClosed", (raw: unknown) => {
    ctx.touch();
    const event = raw as WebSocketClosed;
    const payload: WebSocketClosedPayload = { requestId: event.requestId, targetId };
    ctx.enqueue(async () => {
      ctx.emit("websocket_closed", payload);
      await Promise.resolve();
    });
  });

  cdp.on("Network.eventSourceMessageReceived", (raw: unknown) => {
    ctx.touch();
    const event = raw as EventSourceMessage;
    const kept = capture(event.data, ctx);
    ctx.counters.eventSourceMessages += 1;

    const payload: EventSourceMessagePayload = {
      requestId: event.requestId,
      // SSE defaults an unnamed event to `message`; recording the default
      // explicitly means a consumer never has to know that rule.
      eventName:
        event.eventName === undefined || event.eventName === "" ? "message" : event.eventName,
      ...(event.eventId === undefined || event.eventId === ""
        ? {}
        : { eventId: event.eventId }),
      dataBytes: kept.bytes,
      ...(kept.payload === undefined ? {} : { data: kept.payload }),
      ...(kept.skipped === undefined ? {} : { skipped: kept.skipped }),
      targetId,
    };
    ctx.enqueue(async () => {
      ctx.emit("eventsource_message", payload);
      await Promise.resolve();
    });
  });
}
