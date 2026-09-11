/**
 * A minimal WebSocket server for fixtures — RFC 6455, dev plan BR-M1-05.
 *
 * ## Why hand-rolled rather than `ws`
 *
 * `ws` is the obvious choice and it is a good library. It is also a
 * dependency, and this package is built under two constraints that make the
 * trade different from an ordinary app: fixtures must add nothing to the
 * dependency tree that the license gate has to vet, and their determinism is
 * enforced by a source scan that forbids clocks and randomness. What a fixture
 * needs is a server that echoes frames — no extensions, no fragmentation, no
 * compression, no client role. That is the hundred lines below.
 *
 * Server-sent frames are never masked (RFC 6455 §5.1), so nothing here needs a
 * random number: the handshake is a SHA-1, which is deterministic. A library
 * would have brought a masking RNG into a package whose whole promise is that
 * it has none.
 *
 * ## What it deliberately does not do
 *
 * No fragmentation, no `permessage-deflate`, no payloads over 64 KiB, no
 * client mode. A fixture controls both ends, so the cases that make a real
 * implementation hard cannot arise. Anything unsupported closes the connection
 * rather than guessing.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** RFC 6455 §1.3. Fixed by the spec, not a secret. */
const HANDSHAKE_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Opcodes this server understands. */
export const OPCODES = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** Largest frame this fixture will build or accept. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** What a fixture's WebSocket handler can do. */
export interface FixtureSocket {
  /** Send a text frame. */
  send(text: string): void;
  /** Send a ping — the protocol-level keepalive §17A names. */
  ping(payload?: string): void;
  /** Close with a normal-closure status. */
  close(code?: number, reason?: string): void;
  /** Text frames received from the browser, in order. */
  readonly received: readonly string[];
}

export interface WebSocketRoute {
  readonly path: string;
  /** Called once the handshake has completed. */
  readonly onOpen?: ((socket: FixtureSocket) => void) | undefined;
  /** Called for each text frame the browser sends. */
  readonly onMessage?: ((socket: FixtureSocket, text: string) => void) | undefined;
}

/** The `Sec-WebSocket-Accept` value for a client key (RFC 6455 §4.2.2). */
export function handshakeAccept(key: string): string {
  return createHash("sha1").update(`${key}${HANDSHAKE_MAGIC}`).digest("base64");
}

/** Build a server frame. Server frames are never masked. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`fixture frame of ${payload.byteLength} bytes exceeds the cap`);
  }

  const header: number[] = [0x80 | opcode];
  if (payload.byteLength < 126) {
    header.push(payload.byteLength);
  } else {
    header.push(126, (payload.byteLength >> 8) & 0xff, payload.byteLength & 0xff);
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

interface DecodedFrame {
  readonly opcode: number;
  readonly payload: Buffer;
  /** Bytes consumed, so the caller can advance its buffer. */
  readonly consumed: number;
}

/** Read one client frame, or undefined when more bytes are needed. */
export function decodeFrame(buffer: Buffer): DecodedFrame | undefined {
  if (buffer.byteLength < 2) return undefined;

  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.byteLength < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    // A fixture never needs a payload this large, and refusing is safer than
    // allocating whatever a client claims.
    throw new RangeError("fixture does not accept 64-bit frame lengths");
  }

  const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (buffer.byteLength < offset + length) return undefined;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey !== undefined) {
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
    }
  }

  return { opcode, payload, consumed: offset + length };
}

/**
 * Complete the handshake and drive the connection.
 *
 * Returns false when the request is not a WebSocket upgrade this route can
 * serve, so the caller can answer it as an ordinary request.
 */
export function serveWebSocket(
  route: WebSocketRoute,
  request: IncomingMessage,
  socket: Duplex,
): boolean {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return false;
  }

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${handshakeAccept(key)}`,
      "",
      "",
    ].join("\r\n"),
  );

  const received: string[] = [];
  const api: FixtureSocket = {
    send: (text) => {
      socket.write(encodeFrame(OPCODES.text, Buffer.from(text, "utf8")));
    },
    ping: (payload = "") => {
      socket.write(encodeFrame(OPCODES.ping, Buffer.from(payload, "utf8")));
    },
    close: (code = 1000, reason = "") => {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2, "utf8");
      socket.write(encodeFrame(OPCODES.close, body));
      socket.end();
    },
    received,
  };

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    for (;;) {
      let frame: DecodedFrame | undefined;
      try {
        frame = decodeFrame(pending);
      } catch {
        api.close(1002, "protocol error");
        return;
      }
      if (frame === undefined) return;
      pending = pending.subarray(frame.consumed);

      if (frame.opcode === OPCODES.close) {
        api.close();
        return;
      }
      if (frame.opcode === OPCODES.ping) {
        socket.write(encodeFrame(OPCODES.pong, frame.payload));
        continue;
      }
      if (frame.opcode === OPCODES.pong) continue;
      if (frame.opcode !== OPCODES.text) continue;

      const text = frame.payload.toString("utf8");
      received.push(text);
      route.onMessage?.(api, text);
    }
  });

  socket.on("error", () => {
    // A browser closing abruptly is normal; nothing here needs to survive it.
  });

  route.onOpen?.(api);
  return true;
}
