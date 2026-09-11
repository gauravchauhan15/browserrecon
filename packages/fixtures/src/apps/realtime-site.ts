/**
 * Fixture: WebSocket and Server-Sent Events — build plan §5.1, §17A; dev plan
 * BR-M1-05.
 *
 * §5.1 names WebSocket frames as a capability the MCP tool surface does not
 * expose, and therefore as part of why raw CDP is the transport. This fixture
 * is what proves the claim rather than asserting it.
 *
 * It also has to make the §17A distinction testable. A scan must be able to
 * tell a protocol keepalive from application traffic, so the connection
 * carries both, deliberately mixed:
 *
 *   /ws       echoes text frames, and sends a protocol-level ping on demand
 *   /sse      an event stream containing both data events and `:` comments,
 *             which §17A calls the SSE keepalive
 *   /         a page that opens both and drives a fixed exchange
 *
 * ## Determinism with a live connection
 *
 * Everything is driven by the client, never by a timer. The server sends on
 * connect and in response to what it receives, so the same page produces the
 * same frames in the same order on every run — which the source scan enforces
 * by refusing any clock or random number in this package.
 */
import type { FixtureApp, FixtureResponse } from "../types.js";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;

function page(title: string, body: string): FixtureResponse {
  return {
    status: 200,
    headers: HTML,
    body: [
      "<!doctype html>",
      '<html lang="en">',
      `<head><title>${title}</title></head>`,
      "<body>",
      `<h1>${title}</h1>`,
      body,
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  };
}

/** The exchange the page drives, so a test knows exactly what to expect. */
export const WS_CLIENT_MESSAGES: readonly string[] = ["hello-from-page", "ping-me", "goodbye"];

/** What the server says on connect, before anything is sent to it. */
export const WS_GREETING = "server-greeting";

export function realtimeSite(): FixtureApp {
  return {
    name: "realtime-site",
    websockets: [
      {
        path: "/ws",
        onOpen: (socket) => socket.send(WS_GREETING),
        onMessage: (socket, text) => {
          if (text === "ping-me") {
            // Both kinds of keepalive, deliberately.
            //
            // The protocol ping (opcode 0x9) is what §17A names first — and
            // measuring it showed that CDP does not report control frames at
            // all, so no tool built on the DevTools protocol can see it. It is
            // still sent here so a test can pin that limitation: if Chrome
            // ever starts surfacing control frames, that test fails and tells
            // us the constraint has lifted.
            //
            // The application-level keepalive below is the one a scan can
            // actually observe, and therefore the one §17A's classification
            // has to work from in practice.
            socket.ping("keepalive");
            socket.send('{"type":"ping"}');
            return;
          }
          if (text === "goodbye") {
            socket.close(1000, "done");
            return;
          }
          socket.send(`echo:${text}`);
        },
      },
    ],
    routes: [
      {
        method: "GET",
        path: "/",
        handler: () =>
          page(
            "Realtime",
            [
              "<script>",
              `  const messages = ${JSON.stringify(WS_CLIENT_MESSAGES)};`,
              "  const ws = new WebSocket(`ws://${location.host}/ws`);",
              "  window.__frames = [];",
              "  ws.addEventListener('message', (event) => {",
              "    window.__frames.push(event.data);",
              // Driven by what arrives, never by a timer, so the exchange is
              // the same on every run.
              "    const next = messages.shift();",
              "    if (next !== undefined) ws.send(next);",
              "  });",
              "  ws.addEventListener('open', () => ws.send(messages.shift()));",
              "  const source = new EventSource('/sse');",
              "  window.__sse = [];",
              "  source.addEventListener('message', (event) => window.__sse.push(event.data));",
              "  source.addEventListener('tick', (event) => window.__sse.push('tick:' + event.data));",
              "</script>",
            ].join("\n"),
          ),
      },
      {
        method: "GET",
        path: "/sse",
        handler: () => ({
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
          stream: (write, end) => {
            // A `:` line is a comment. §17A calls it the SSE keepalive, and it
            // has to be present for a scan to be able to tell it from a data
            // event carrying application state.
            write(": keepalive\n\n");
            write("data: first\n\n");
            write("event: tick\ndata: 1\n\n");
            write(": keepalive\n\n");
            write("data: second\n\n");
            write("event: tick\nid: 42\ndata: 2\n\n");
            end();
          },
        }),
      },
    ],
  };
}
