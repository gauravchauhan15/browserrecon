/**
 * Wait for a condition, with a deadline — test support.
 *
 * `Telemetry.drain(quietMs)` settles on a *gap* in CDP events, and its own
 * documentation says it is a settle rather than a guarantee. That is honest
 * about the browser, and it makes a poor basis for an assertion: under load
 * the gap can appear before Chrome has finished, so a test that drains and
 * then asserts is really asserting that the machine was not busy.
 *
 * Two telemetry tests flaked that way — only ever in the full suite, never
 * when the browser project ran alone, which is the signature of a timing
 * heuristic rather than a bug. Waiting for the specific condition removes
 * the guess: the test passes as soon as what it needs has arrived, and fails
 * with a clear timeout if it genuinely never does.
 *
 * ## The ceiling is deliberately generous
 *
 * It was eight seconds, and a test whose healthy case is 1.3 s still hit it
 * in the full suite — the same flake this helper exists to prevent, surviving
 * in the one number that had been left as a guess.
 *
 * The two costs are not symmetric. A ceiling set too high is paid only when
 * something is genuinely broken, once, as a slower failure. A ceiling set too
 * low is paid at random on healthy runs, and teaches everyone to re-run until
 * green — which is the habit that lets a real failure through. So this is
 * sized for a loaded CI runner with several browsers on it, not for an idle
 * laptop. Reaching it still means the event never arrived.
 */
export async function waitUntil(
  predicate: () => boolean,
  options: { readonly timeoutMs?: number; readonly what?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (predicate()) return;
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${options.what ?? "a condition"} — ` +
      "the event never arrived, rather than arriving late",
  );
}
