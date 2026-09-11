import type { WebSocketRoute } from "./websocket.js";

/**
 * Fixture app contract — build plan §36.1, dev plan BR-M0-13.
 *
 * A fixture app is a *declaration*, not a running server: a name plus a list
 * of routes, each a pure function from a request to a response. The harness
 * turns one into a listening server (see harness.ts).
 *
 * Keeping apps declarative is what makes the determinism rules checkable. A
 * handler that receives its state as an argument and returns a response cannot
 * quietly read a clock, and the app can be inspected, listed and reasoned
 * about without starting anything.
 */

/** What a handler is told about the incoming request. */
export interface FixtureRequest {
  readonly method: string;
  /** Path without the query string, e.g. `/products/2`. */
  readonly pathname: string;
  /** Parsed query parameters. Repeated keys keep only the first value. */
  readonly query: Readonly<Record<string, string>>;
  /** Values captured from a `:name` segment in the route's path pattern. */
  readonly params: Readonly<Record<string, string>>;
  /** Lower-cased header names, as Node delivers them. */
  readonly headers: Readonly<Record<string, string>>;
  /** Request body, empty for methods that carry none. */
  readonly body: string;
}

export interface FixtureResponse {
  readonly status: number;
  /**
   * Response headers. `content-length` is computed by the harness and must not
   * be set here; anything else is emitted verbatim in the order given.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /**
   * Write the body in chunks instead of all at once.
   *
   * For Server-Sent Events, where the response deliberately never ends until
   * the fixture says so. `content-length` is omitted when this is used — the
   * point of the response is that its length is not known up front, and
   * declaring one would make the browser stop reading after the first chunk.
   *
   * A streaming fixture still may not use a clock: `write` everything the test
   * needs and call `end`, so the sequence is the same every run.
   */
  readonly stream?: ((write: (chunk: string) => void, end: () => void) => void) | undefined;
}

/**
 * Per-instance mutable state, for apps that model a cart or a session.
 *
 * State is the one thing a fixture may carry between requests, and it is
 * deliberately handed in rather than closed over: the harness builds it fresh
 * from `seedState` for every server instance, so two runs that issue the same
 * request sequence see the same bytes. A handler that closed over a module
 * variable would leak state between tests and destroy that guarantee.
 */
export type FixtureState = Record<string, unknown>;

export type FixtureHandler = (request: FixtureRequest, state: FixtureState) => FixtureResponse;

export interface FixtureRoute {
  readonly method: string;
  /** Exact path, or a pattern with `:name` segments (`/products/:id`). */
  readonly path: string;
  readonly handler: FixtureHandler;
}

export interface FixtureApp {
  /** Identifies the app in failures and in golden-output paths. */
  readonly name: string;
  readonly routes: readonly FixtureRoute[];
  /**
   * Builds this app's starting state. Called once per server instance, so it
   * must return a fresh object rather than a shared one.
   */
  readonly seedState?: (() => FixtureState) | undefined;
  /** Response for a path no route matches. Defaults to a plain 404. */
  readonly notFound?: FixtureHandler | undefined;
  /**
   * WebSocket endpoints.
   *
   * Separate from `routes` because an upgrade is not a request/response: the
   * handler is handed a live connection, and the harness never writes a status
   * line for it after the handshake.
   */
  readonly websockets?: readonly WebSocketRoute[] | undefined;
}

/** One request a running fixture received, in arrival order. */
export interface RecordedRequest {
  /**
   * Arrival order, from 1. A sequence number rather than a timestamp: the
   * recording has to be as reproducible as the responses, and a clock would
   * make every assertion over it unstable.
   */
  readonly sequence: number;
  readonly method: string;
  readonly pathname: string;
  readonly query: Readonly<Record<string, string>>;
  /**
   * Headers exactly as the client sent them.
   *
   * `host` is the one field in this whole package that is NOT reproducible
   * across runs: it carries the ephemeral port, which differs by design.
   * Recorded verbatim rather than scrubbed, because a recon tool's fixture
   * should not lie about what arrived — but anything that snapshots a recorded
   * request must mask it (BR-M0-14's normalizer does). `harness.test.ts` pins
   * this so it cannot become a surprise golden-test flake later.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Status the fixture answered with. */
  readonly status: number;
}
