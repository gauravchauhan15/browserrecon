/**
 * Network egress guard — dev plan BR-M0-02.
 *
 * Asserts that BrowserRecon opens no connection other than to the scan target
 * and localhost. This mechanically enforces two promises the build plan makes
 * in prose:
 *
 *   §38    no telemetry, ever, by default
 *   §37.1  target data, credentials and AI inference stay on the machine
 *
 * It exists now, before any network code does, because its job is to catch an
 * exfiltration path introduced later — by a contributor, an AI-generated
 * mistake, or a compromised dependency. A tripwire installed after the fact
 * only guards what you already thought to check.
 *
 * Interception happens at Node's socket and DNS layers, which is where every
 * higher-level client (http, https, undici, fetch, Puppeteer's own transport)
 * ultimately funnels through — so it cannot be sidestepped by choosing a
 * different HTTP library.
 */
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

/** A recorded connection attempt. */
export interface EgressAttempt {
  /** Hostname or IP the code tried to reach. */
  readonly host: string;
  /** Port, where the interception layer exposed one. */
  readonly port: number | undefined;
  /** Which layer caught it — useful when diagnosing a leak. */
  readonly via: "net.connect" | "tls.connect" | "dns.lookup";
  /** Whether the destination was permitted. */
  readonly allowed: boolean;
}

export interface EgressGuardOptions {
  /**
   * Hosts this scan is legitimately allowed to reach — normally the target
   * origin's hostname. Localhost and loopback are always permitted.
   */
  readonly allowHosts?: readonly string[];
  /**
   * Throw on a disallowed attempt (default). Set false to record silently,
   * which is only useful when asserting over the recorded list afterwards.
   */
  readonly throwOnViolation?: boolean;
}

export interface EgressGuard {
  /** Every attempt seen, in order. */
  readonly attempts: readonly EgressAttempt[];
  /** Attempts that were not permitted. */
  readonly violations: readonly EgressAttempt[];
  /** Restore the original network functions. Always call this in teardown. */
  restore(): void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK.has(normalized) || normalized.startsWith("127.");
}

/** Pull a hostname out of the many shapes Node's connect APIs accept. */
function extractTarget(args: readonly unknown[]): { host: string; port: number | undefined } {
  const [first, second] = args;

  if (typeof first === "object" && first !== null) {
    const opts = first as { host?: string; hostname?: string; port?: number; path?: string };
    // A unix socket path is not egress.
    if (typeof opts.path === "string" && opts.path.length > 0) {
      return { host: "localhost", port: undefined };
    }
    return { host: opts.host ?? opts.hostname ?? "localhost", port: opts.port };
  }

  if (typeof first === "number") {
    return { host: typeof second === "string" ? second : "localhost", port: first };
  }

  // A string first argument is an IPC path, not a network destination.
  return { host: "localhost", port: undefined };
}

/**
 * Install the guard. Returns a handle exposing what was attempted; call
 * `restore()` in teardown or later tests inherit the patched functions.
 */
export function installEgressGuard(options: EgressGuardOptions = {}): EgressGuard {
  const allowHosts = new Set((options.allowHosts ?? []).map((h) => h.toLowerCase()));
  const shouldThrow = options.throwOnViolation ?? true;

  const attempts: EgressAttempt[] = [];
  const violations: EgressAttempt[] = [];

  const permitted = (host: string): boolean =>
    isLoopback(host) || allowHosts.has(host.toLowerCase());

  const record = (
    host: string,
    port: number | undefined,
    via: EgressAttempt["via"],
  ): EgressAttempt => {
    const attempt: EgressAttempt = { host, port, via, allowed: permitted(host) };
    attempts.push(attempt);
    if (!attempt.allowed) violations.push(attempt);
    return attempt;
  };

  const fail = (attempt: EgressAttempt): never => {
    const where = attempt.port === undefined ? attempt.host : `${attempt.host}:${attempt.port}`;
    throw new Error(
      `Egress blocked: ${where} (via ${attempt.via}).\n` +
        `BrowserRecon must not contact anything but the scan target and localhost ` +
        `(build plan §37.1, §38).\n` +
        `Allowed hosts for this test: ${[...allowHosts].join(", ") || "(localhost only)"}`,
    );
  };

  const originals = {
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
    dnsLookup: dns.lookup,
  } as const;

  /**
   * Node's connect signatures are heavily overloaded, so the patched wrappers
   * are typed loosely here and re-asserted to the original signature at the
   * assignment. The `unknown[]` boundary is where that looseness is contained.
   */
  type LooseFn = (...args: unknown[]) => unknown;

  const guardConnect = (original: LooseFn, via: EgressAttempt["via"]): LooseFn => {
    return (...args: unknown[]): unknown => {
      const { host, port } = extractTarget(args);
      const attempt = record(host, port, via);
      if (!attempt.allowed && shouldThrow) fail(attempt);
      return original(...args);
    };
  };

  net.connect = guardConnect(
    originals.netConnect as unknown as LooseFn,
    "net.connect",
  ) as unknown as typeof net.connect;

  net.createConnection = guardConnect(
    originals.netCreateConnection as unknown as LooseFn,
    "net.connect",
  ) as unknown as typeof net.createConnection;

  tls.connect = guardConnect(
    originals.tlsConnect as unknown as LooseFn,
    "tls.connect",
  ) as unknown as typeof tls.connect;

  // DNS resolution of a disallowed host is itself a leak: it tells a resolver
  // operator what is being scanned, even if the connection never completes.
  const guardedLookup = (hostname: string, ...rest: unknown[]): unknown => {
    const attempt = record(hostname, undefined, "dns.lookup");
    if (!attempt.allowed && shouldThrow) fail(attempt);
    return (originals.dnsLookup as unknown as LooseFn)(hostname, ...rest);
  };
  dns.lookup = guardedLookup as unknown as typeof dns.lookup;

  return {
    attempts,
    violations,
    restore(): void {
      net.connect = originals.netConnect;
      net.createConnection = originals.netCreateConnection;
      tls.connect = originals.tlsConnect;
      dns.lookup = originals.dnsLookup;
    },
  };
}
