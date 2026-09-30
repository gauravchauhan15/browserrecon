/**
 * Liveness probing — build plan §10C.7; dev plan BR-M3-09c.
 *
 * "A JS bundle referencing an endpoint removed months ago is
 * indistinguishable from a live endpoint we simply never triggered — unless
 * we ask."
 *
 * ## The response is often more informative than a 200
 *
 * That is the part worth stating plainly. A `401` or `403` is *positive
 * confirmation of real, gated surface* — better intelligence than a 200,
 * because it says both that the endpoint exists and that something is
 * protecting it. A `405` confirms the endpoint is real and the method was
 * wrong. Only `404`/`410` deprioritise anything.
 *
 * ## Four rules, and the first is why this module is mostly refusals
 *
 * §10C.7: probing is **opt-in**, "since it issues requests the application
 * itself never made"; it counts against the shared rate budget; it never uses
 * a method outside policy; and it is capped at one probe per unique
 * candidate.
 *
 * A scan that probed by default would be sending traffic nobody asked for to
 * endpoints nobody visited — which is a different activity from observing a
 * browser, however read-only each request is.
 */

/** Methods a probe may use. Both are in the default allowed set (§7.2). */
export const PROBE_METHODS = ["HEAD", "OPTIONS"] as const;
export type ProbeMethod = (typeof PROBE_METHODS)[number];

export const PROBE_OUTCOMES = [
  "probably_dead",
  "exists_gated",
  "exists_wrong_method",
  "reachable",
  "unknown",
] as const;

export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

export interface ProbeVerdict {
  readonly outcome: ProbeOutcome;
  /** What this means for the gap, in words a report can print. */
  readonly meaning: string;
  /** Whether the candidate should be promoted out of the gap queue. */
  readonly promote: boolean;
}

/**
 * Read a probe's response.
 *
 * §10C.7's table, implemented as its table. A status nobody listed is
 * `unknown` rather than guessed at — a 500 says the server is unhappy, not
 * whether the endpoint exists.
 */
export function classifyProbe(status: number | undefined): ProbeVerdict {
  if (status === undefined) {
    return {
      outcome: "unknown",
      meaning: "the probe did not complete; the candidate is neither confirmed nor ruled out",
      promote: false,
    };
  }

  if (status === 404 || status === 410) {
    return {
      outcome: "probably_dead",
      meaning: `the server answered ${status}; the reference is probably stale`,
      promote: false,
    };
  }

  if (status === 401 || status === 403) {
    // The valuable one. Existence confirmed *and* something is protecting
    // it, for the cost of one request.
    return {
      outcome: "exists_gated",
      meaning: `${status} confirms the endpoint exists and access is gated`,
      promote: false,
    };
  }

  if (status === 405) {
    return {
      outcome: "exists_wrong_method",
      meaning: "405 confirms the endpoint exists; the probe method is not the one it takes",
      promote: false,
    };
  }

  if (status >= 200 && status < 400) {
    return {
      outcome: "reachable",
      meaning: `${status}: the endpoint exists and is reachable`,
      promote: true,
    };
  }

  return {
    outcome: "unknown",
    meaning: `${status} says nothing conclusive about whether the endpoint exists`,
    promote: false,
  };
}

export interface ProbePlan {
  readonly url: string;
  readonly method: ProbeMethod;
}

export interface PlanProbesInput {
  /** Candidates worth asking about, highest priority first. */
  readonly candidates: readonly string[];
  /** Opt-in. Nothing is probed unless this is true (§10C.7). */
  readonly enabled: boolean;
  /** Methods the policy permits. A probe never steps outside it. */
  readonly allowedMethods: readonly string[];
  /** Whether a URL is in scope. The same engine the rest of the scan uses. */
  readonly allowed: (url: string) => boolean;
  /** Ceiling, so a large gap queue cannot become a large amount of traffic. */
  readonly maxProbes?: number | undefined;
}

export interface ProbePlanResult {
  readonly probes: readonly ProbePlan[];
  /** Candidates not probed, with why. Reported, never silent. */
  readonly skipped: readonly { readonly url: string; readonly reason: string }[];
}

const DEFAULT_MAX_PROBES = 50;

/**
 * Decide what to probe.
 *
 * Every rule here is a refusal. The one thing it does affirmatively is emit a
 * `HEAD` for a candidate that passed all of them — and even that prefers
 * `OPTIONS` when `HEAD` is not allowed, rather than reaching for anything
 * else.
 */
export function planProbes(input: PlanProbesInput): ProbePlanResult {
  const probes: ProbePlan[] = [];
  const skipped: { url: string; reason: string }[] = [];

  if (!input.enabled) {
    // Not an error. The default, and the reason is that probing issues
    // requests the application never made.
    return {
      probes: [],
      skipped: input.candidates.map((url) => ({
        url,
        reason: "liveness probing is off; enable it with --probe-liveness",
      })),
    };
  }

  const method = (["HEAD", "OPTIONS"] as const).find((candidate) =>
    input.allowedMethods.map((allowed) => allowed.toUpperCase()).includes(candidate),
  );
  if (method === undefined) {
    return {
      probes: [],
      skipped: input.candidates.map((url) => ({
        url,
        reason: "neither HEAD nor OPTIONS is in the policy's allowed methods",
      })),
    };
  }

  // One per unique candidate, §10C.7's cap. Deduplicated before the ceiling
  // so a queue full of one repeated URL does not exhaust it.
  const seen = new Set<string>();
  const limit = input.maxProbes ?? DEFAULT_MAX_PROBES;

  for (const url of input.candidates) {
    if (seen.has(url)) {
      skipped.push({ url, reason: "already probed; one probe per unique candidate" });
      continue;
    }
    seen.add(url);

    if (!input.allowed(url)) {
      skipped.push({ url, reason: "outside the target policy" });
      continue;
    }
    if (probes.length >= limit) {
      skipped.push({ url, reason: `the ${limit}-probe ceiling is reached` });
      continue;
    }

    probes.push({ url, method });
  }

  return { probes, skipped };
}
