/**
 * Fixture server harness — build plan §36.1, dev plan BR-M0-13.
 *
 * Starts a declared fixture app on an ephemeral loopback port and hands back
 * the origin to point a scan at.
 *
 * ## Why `node:http` and not Express
 *
 * A deviation from the dev plan, which said Express. These apps serve fixed
 * strings through about a dozen routes; Express would add roughly thirty
 * packages to the dependency tree — every one of which the license gate has to
 * vet and a contributor has to trust — to save the forty lines of routing
 * below. The later fixtures (auth, 429 throttling, SPA routing, slow APIs)
 * need hand-written behaviour rather than middleware anyway. Reversing this is
 * cheap if a fixture ever genuinely needs Express: the `FixtureApp` contract
 * says nothing about how it is served.
 *
 * ## Determinism is a property of the wire bytes, not just the body
 *
 * §36.2's golden-output tests compare normalized output across runs, which
 * only means anything if the fixture answers identically each time. The body
 * is the easy part. The traps are in the response *envelope*:
 *
 *   - Node sets a `Date` header on every response. That alone makes every
 *     response differ from the last, so `sendDate` is turned off.
 *   - `Keep-Alive: timeout=N` is derived from the server's keep-alive timeout,
 *     whose default has changed between Node releases. It is pinned here so a
 *     Node upgrade cannot silently change fixture bytes.
 *   - A `Location` header containing an absolute URL would embed the ephemeral
 *     port, which differs per run by design. Redirects must be relative, and a
 *     test asserts it.
 *
 * ## Binding
 *
 * Always `127.0.0.1`, never `0.0.0.0`. A fixture that binds every interface
 * puts a fake application with fake credentials on the tester's network.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  FixtureApp,
  FixtureRequest,
  FixtureResponse,
  FixtureState,
  RecordedRequest,
} from "./types.js";

/**
 * Pinned so fixture response bytes cannot change with a Node upgrade.
 * The value is arbitrary; that it is fixed is the point.
 */
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

/** Loopback only. See the binding note above. */
const HOST = "127.0.0.1";

export interface RunningFixture {
  readonly app: FixtureApp;
  /** `http://127.0.0.1:<port>` — what to point a scan at. */
  readonly origin: string;
  readonly port: number;
  /** Every request received, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  /** Forget recorded requests, keeping the server and its state. */
  resetRequests(): void;
  /** Stop listening and drop keep-alive connections. Safe to call twice. */
  close(): Promise<void>;
}

/** Split a path pattern's `:name` segments out of a concrete path. */
function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? "";
    const actual = pathParts[index] ?? "";
    if (expected.startsWith(":")) {
      // An empty segment is not a match: `/products/` must not satisfy
      // `/products/:id` and then hand a handler an empty id.
      if (actual === "") return undefined;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

function readBody(message: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    message.on("data", (chunk: Buffer) => chunks.push(chunk));
    message.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    message.on("error", reject);
  });
}

function normalizeHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return headers;
}

const PLAIN_NOT_FOUND: FixtureResponse = {
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: "not found\n",
};

/**
 * Resolve a request against an app's routes.
 *
 * A path that matches a route under a different method answers 405 rather than
 * 404, because the distinction is one a recon tool is supposed to notice: a
 * 405 says the endpoint exists.
 */
function route(
  app: FixtureApp,
  request: Omit<FixtureRequest, "params">,
  state: FixtureState,
): FixtureResponse {
  const allowed: string[] = [];

  for (const candidate of app.routes) {
    const params = matchPath(candidate.path, request.pathname);
    if (params === undefined) continue;
    if (candidate.method !== request.method) {
      allowed.push(candidate.method);
      continue;
    }
    return candidate.handler({ ...request, params }, state);
  }

  if (allowed.length > 0) {
    return {
      status: 405,
      headers: {
        allow: [...new Set(allowed)].sort().join(", "),
        "content-type": "text/plain; charset=utf-8",
      },
      body: "method not allowed\n",
    };
  }

  return app.notFound === undefined
    ? PLAIN_NOT_FOUND
    : app.notFound({ ...request, params: {} }, state);
}

function send(response: ServerResponse, result: FixtureResponse): void {
  const body = Buffer.from(result.body ?? "", "utf8");
  const headers: Record<string, string> = { ...(result.headers ?? {}) };

  // Computed, never declared by a handler: a hand-written content-length that
  // disagreed with the body would produce a hang or a truncated response, and
  // debugging that from a scan's output is miserable.
  headers["content-length"] = String(body.byteLength);

  response.writeHead(result.status, headers);
  response.end(body);
}

export interface StartFixtureOptions {
  /**
   * Port to listen on. Defaults to 0 — an ephemeral port chosen by the OS,
   * which is what makes parallel tests safe from collisions. Pass a fixed port
   * only when something outside the process has to know it in advance.
   */
  readonly port?: number | undefined;
}

/** Start a declared app. Always `await` the returned `close()` in teardown. */
export async function startFixture(
  app: FixtureApp,
  options: StartFixtureOptions = {},
): Promise<RunningFixture> {
  const state: FixtureState = app.seedState?.() ?? {};
  const requests: RecordedRequest[] = [];
  let sequence = 0;

  const server = createServer((incoming, outgoing) => {
    // Without this Node stamps every response with the current time, and no
    // two runs would ever agree.
    outgoing.sendDate = false;

    void (async (): Promise<void> => {
      const url = new URL(incoming.url ?? "/", `http://${HOST}`);
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (!(key in query)) query[key] = value;
      }

      const request = {
        method: incoming.method ?? "GET",
        pathname: url.pathname,
        query,
        headers: normalizeHeaders(incoming),
        body: await readBody(incoming),
      };

      let result: FixtureResponse;
      try {
        result = route(app, request, state);
      } catch (error) {
        // A throwing handler is a bug in the fixture, and a fixture bug that
        // surfaces as a hung socket is far harder to diagnose than a 500 whose
        // body names the app.
        result = {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: `fixture "${app.name}" handler threw: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        };
      }

      sequence += 1;
      requests.push({ sequence, ...request, status: result.status });
      send(outgoing, result);
    })();
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  let closed = false;
  return {
    app,
    origin: `http://${HOST}:${address.port}`,
    port: address.port,
    requests,
    resetRequests: () => {
      requests.length = 0;
      sequence = 0;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // Idle keep-alive sockets keep the server open, so a test that finished
      // its requests would otherwise hang here until the timeout.
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/**
 * Start a fixture, run a test body against it, and always shut it down.
 *
 * Worth having because a leaked fixture server holds the Vitest worker open,
 * which surfaces as a timeout in an unrelated test file rather than as an
 * error in the one that forgot to close it.
 */
export async function withFixture<T>(
  app: FixtureApp,
  body: (fixture: RunningFixture) => Promise<T>,
  options: StartFixtureOptions = {},
): Promise<T> {
  const fixture = await startFixture(app, options);
  try {
    return await body(fixture);
  } finally {
    await fixture.close();
  }
}
