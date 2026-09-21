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
 */
export async function waitUntil(
  predicate: () => boolean,
  options: { readonly timeoutMs?: number; readonly what?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 8_000;
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
