/**
 * Which response bodies to keep — build plan §41.
 *
 * A scan of a real application moves hundreds of megabytes. Keeping all of it
 * makes the event log unusable and the export slow; keeping none of it removes
 * the evidence the JS mining (§10A) and API modelling (§15) stages are built
 * on. §41 settles the shape of the compromise — "images/fonts: metadata only,
 * API JSON/text responses: configurable body capture" — and this file is that
 * rule set, in one place, with each entry's reason beside it.
 *
 * Two independent limits, because they fail differently. A **per-body cap**
 * stops one 40 MB bundle from dominating a log. A **per-scan budget** stops
 * ten thousand small bodies from doing the same thing slowly. Hitting either
 * is recorded on the event rather than silently changing what was kept: a
 * consumer reading `skipped: "budget_exhausted"` knows the log is complete but
 * thinner from that point on, which is a different fact from "this response
 * had no body".
 */

/** Content types worth keeping, and why. Order matters: first match wins. */
export const BODY_CAPTURE_RULES: readonly {
  readonly pattern: RegExp;
  readonly capture: boolean;
  readonly why: string;
}[] = [
  {
    pattern: /^application\/(json|.*\+json)/i,
    capture: true,
    why: "API responses are the attack surface this tool exists to model (§15).",
  },
  {
    pattern: /^(text\/javascript|application\/(javascript|x-javascript|ecmascript))/i,
    capture: true,
    why: "Endpoints reachable only by parsing JS (§10A) are invisible without the source.",
  },
  {
    pattern: /^text\/html/i,
    capture: true,
    why: "Forms, links and inline script are read from the markup.",
  },
  {
    pattern:
      /^(text\/plain|text\/css|application\/xml|text\/xml|application\/x-www-form-urlencoded)/i,
    capture: true,
    why: "Small, occasionally carries endpoints or configuration.",
  },
  {
    pattern: /^(image|font|audio|video)\//i,
    capture: false,
    why: "§41: metadata only. Bulk with no recon value, and the bulk is the problem.",
  },
  {
    pattern: /^application\/(octet-stream|pdf|zip|gzip|wasm)/i,
    capture: false,
    why: "Opaque binary. Nothing downstream reads it, and it is usually large.",
  },
];

/** Used when the response declares no content type at all. */
const UNKNOWN_TYPE_CAPTURED = false;

export interface BodyCaptureLimits {
  /** Largest single body kept, in bytes. Bigger ones are skipped whole. */
  readonly maxBodyBytes: number;
  /** Total body bytes kept across the scan. */
  readonly maxTotalBytes: number;
  /** Turn body capture off entirely. */
  readonly enabled: boolean;
}

export const DEFAULT_BODY_LIMITS: BodyCaptureLimits = {
  // Comfortably holds an API response or a page; a 5 MB minified bundle is
  // skipped, and §10B.9 already treats those as a separate, bounded job.
  maxBodyBytes: 512 * 1024,
  // ~250 MB of captured text across a scan, which the event store streams
  // rather than holds.
  maxTotalBytes: 256 * 1024 * 1024,
  enabled: true,
};

export type SkipReason = "disabled" | "policy" | "too_large" | "budget_exhausted";

export type CaptureDecision =
  | { readonly capture: true }
  | { readonly capture: false; readonly reason: SkipReason; readonly detail: string };

export interface CaptureInput {
  readonly mimeType: string | undefined;
  /** Chrome's reported encoded length, when known before fetching. */
  readonly encodedDataLength: number | undefined;
  /** Bytes already captured this scan. */
  readonly bytesSoFar: number;
  readonly limits: BodyCaptureLimits;
}

/** Whether to fetch this response's body. */
export function shouldCaptureBody(input: CaptureInput): CaptureDecision {
  if (!input.limits.enabled) {
    return { capture: false, reason: "disabled", detail: "body capture is switched off" };
  }

  if (input.bytesSoFar >= input.limits.maxTotalBytes) {
    return {
      capture: false,
      reason: "budget_exhausted",
      detail: `scan body budget of ${input.limits.maxTotalBytes} bytes is spent`,
    };
  }

  const mime = (input.mimeType ?? "").split(";")[0]?.trim() ?? "";
  if (mime === "") {
    return UNKNOWN_TYPE_CAPTURED
      ? { capture: true }
      : { capture: false, reason: "policy", detail: "no content type declared" };
  }

  const rule = BODY_CAPTURE_RULES.find((candidate) => candidate.pattern.test(mime));
  if (rule === undefined) {
    return { capture: false, reason: "policy", detail: `no rule captures ${mime}` };
  }
  if (!rule.capture) {
    return { capture: false, reason: "policy", detail: rule.why };
  }

  // Checked before fetching, so an oversized body is never pulled into memory
  // just to be discarded.
  if (
    input.encodedDataLength !== undefined &&
    input.encodedDataLength > input.limits.maxBodyBytes
  ) {
    return {
      capture: false,
      reason: "too_large",
      detail: `${input.encodedDataLength} bytes exceeds the ${input.limits.maxBodyBytes} byte cap`,
    };
  }

  return { capture: true };
}

/** Render the rules as a table, so the README cannot drift from the code. */
export function renderCaptureTable(): string {
  const rows = BODY_CAPTURE_RULES.map(
    (rule) =>
      `| \`${rule.pattern.source.replace(/\|/g, "\\|")}\` | ${rule.capture ? "captured" : "metadata only"} | ${rule.why} |`,
  );
  return ["| Content type | Body | Why |", "| ------------ | ---- | --- |", ...rows].join("\n");
}
