/**
 * Address classification — build plan §7.1 network boundaries.
 *
 * Security-critical. A tool pointed at a public URL that reaches
 * `127.0.0.1` or `10.0.0.5` is either a misconfiguration or SSRF-shaped, and
 * the check that prevents it cannot be a string comparison against the
 * hostname: `internal.example.com` may resolve to a private address, and
 * `::ffff:127.0.0.1` is loopback wearing an IPv6 hat.
 *
 * Ranges are named individually rather than folded together so a denial can
 * say *which* boundary it hit.
 */
import net from "node:net";

/** Why an address is not publicly routable. */
export type AddressClass =
  | "loopback"
  | "private"
  | "link_local"
  | "unspecified"
  | "shared_cgnat"
  | "benchmark"
  | "multicast"
  | "reserved"
  | "public";

function ipv4Class(octets: readonly number[]): AddressClass {
  const [a = 0, b = 0] = octets;

  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link_local";
  // RFC 6598 carrier-grade NAT: not private, but not publicly routable either.
  if (a === 100 && b >= 64 && b <= 127) return "shared_cgnat";
  // RFC 2544 benchmarking range, used by some cloud metadata setups.
  if (a === 198 && (b === 18 || b === 19)) return "benchmark";
  if (a === 192 && b === 0) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";

  return "public";
}

/** Parse a colon-separated run of hextets, allowing a trailing IPv4 literal. */
function parseHextets(run: string): number[] | undefined {
  if (run === "") return [];

  const groups: number[] = [];
  for (const part of run.split(":")) {
    // A trailing IPv4 literal, as in ::ffff:127.0.0.1 or 64:ff9b::1.2.3.4
    if (part.includes(".")) {
      if (!net.isIPv4(part)) return undefined;
      const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = part.split(".").map(Number);
      groups.push((o0 << 8) | o1, (o2 << 8) | o3);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/** Expand an IPv6 address to its 8 hextets, or undefined if malformed. */
function expandIpv6(address: string): number[] | undefined {
  const zone = address.indexOf("%");
  const bare = (zone === -1 ? address : address.slice(0, zone)).toLowerCase();

  const sections = bare.split("::");
  if (sections.length > 2) return undefined;

  const head = parseHextets(sections[0] ?? "");
  if (head === undefined) return undefined;

  // No "::" means the address must already be fully written out.
  if (sections.length === 1) {
    return head.length === 8 ? head : undefined;
  }

  const tail = parseHextets(sections[1] ?? "");
  if (tail === undefined) return undefined;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return undefined;

  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

function ipv6Class(address: string): AddressClass {
  const groups = expandIpv6(address);
  if (groups === undefined) return "reserved";

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const topFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // Order matters here. `::1` and `::0.0.0.1` are the same 128 bits, so the
  // v4-compatible unwrap has to come *after* loopback, or `::1` classifies as
  // IPv4 `0.0.0.1` and comes back "unspecified" instead of "loopback".
  if (groups.every((group) => group === 0)) return "unspecified";
  if (topFiveZero && g5 === 0 && g6 === 0 && g7 === 1) return "loopback";

  // IPv4-mapped (::ffff:a.b.c.d) — the classic bypass. Classifying this as
  // "some IPv6 address" would let ::ffff:127.0.0.1 walk past a loopback check.
  if (topFiveZero && g5 === 0xffff) {
    return ipv4Class([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }

  // IPv4-compatible (::a.b.c.d), deprecated but still accepted by resolvers.
  // Requires a non-zero high half so it cannot swallow `::1`-shaped addresses.
  if (topFiveZero && g5 === 0 && g6 !== 0) {
    return ipv4Class([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }

  if ((g0 & 0xffc0) === 0xfe80) return "link_local";
  // RFC 4193 unique local — the IPv6 equivalent of RFC 1918.
  if ((g0 & 0xfe00) === 0xfc00) return "private";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  // RFC 6666 discard-only, and the RFC 3849 documentation range.
  if (g0 === 0x0100 && g1 === 0) return "reserved";
  if (g0 === 0x2001 && g1 === 0x0db8) return "reserved";

  return "public";
}

/**
 * Classify a literal IP address.
 *
 * Anything unparseable is treated as `reserved` rather than `public`: an
 * address this code does not understand must not be assumed safe.
 */
export function classifyAddress(address: string): AddressClass {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");

  if (net.isIPv4(trimmed)) {
    return ipv4Class(trimmed.split(".").map(Number));
  }
  if (net.isIPv6(trimmed)) {
    return ipv6Class(trimmed);
  }
  return "reserved";
}

/** Whether a hostname is a literal address rather than a name needing DNS. */
export function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return net.isIP(bare) !== 0;
}

/** Every class that is not publicly routable. */
export function isPubliclyRoutable(address: string): boolean {
  return classifyAddress(address) === "public";
}
