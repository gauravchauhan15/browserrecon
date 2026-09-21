/**
 * What counts as "the same page" for the visit queue — dev plan BR-M1-12.
 *
 * Deliberately *not* the same rule as `@browserrecon/collector-network`'s URL
 * identity, and the difference is the point. That one answers "is this the
 * same endpoint?" and must keep `/Admin` and `/admin` apart because they can
 * be different resources. This one answers "have we already been here?", and
 * the cost of the two answers being wrong is opposite:
 *
 *   over-merging   a page never gets visited        — lost coverage
 *   under-merging  the same page is visited twice   — wasted budget
 *
 * Lost coverage is worse than a wasted request, so this errs towards visiting.
 * It therefore normalizes *less* than the network collector: only the
 * fragment is dropped, because a fragment cannot change what the server
 * returns, and everything else is left alone.
 */

/**
 * A key for "already visited", or undefined if this is not a page to visit.
 *
 * Returns undefined for anything that is not http(s) — `mailto:`, `tel:`,
 * `javascript:`, `data:` — which is the queue's cheapest scope check and
 * stops the Explorer trying to navigate to a phone number.
 */
export function normalizeIdentity(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  // The fragment never reaches the server, so two URLs differing only there
  // are the same document — but see §16: the *soft navigation* they cause is
  // recorded separately, so nothing is lost by not visiting twice.
  parsed.hash = "";
  return parsed.href;
}
