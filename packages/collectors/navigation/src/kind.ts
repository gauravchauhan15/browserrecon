/**
 * Telling one kind of route change from another — build plan §16; dev plan
 * BR-M1-07.
 *
 * ## Chrome's own label cannot be used
 *
 * `Page.navigatedWithinDocument` carries a `navigationType`, and the obvious
 * implementation reads it. Measured, it does not say what it appears to:
 *
 *   pushState      -> historyApi
 *   replaceState   -> historyApi     (indistinguishable from a push)
 *   location.hash  -> fragment
 *   back / forward -> fragment       (even when the path changes)
 *
 * So a back button that moves from `/app/orders` to `/app/auto` is reported as
 * a fragment change. Believing that would put a traversal in the log as a
 * hash edit, and §18's workflow boundaries would draw the wrong line.
 *
 * ## What is used instead
 *
 * The Navigation API's position in session history, read at the moment of the
 * change (telemetry captures it; see `SoftNavigationPayload`). The index and
 * the entry count together separate the four cases without ambiguity:
 *
 *   | change              | index | entries | meaning   |
 *   | ------------------- | ----- | ------- | --------- |
 *   | pushState           | +1    | +1      | push      |
 *   | replaceState        | same  | same    | replace   |
 *   | location.hash       | +1    | +1      | hash *    |
 *   | back / forward      | moves | same    | traverse  |
 *
 * \\* a hash change is a push whose URL differs only in its fragment, so the
 * fragment comparison is what separates the two — the history movement is
 * identical.
 *
 * Where the Navigation API is unavailable — a sandboxed frame, an older
 * Chrome — there is no index to compare, and the subtype falls back to
 * Chrome's label with `basis: "cdp_label"` recorded so a consumer knows the
 * answer is the weaker one.
 */

/** How the URL changed, in terms §16.2's workflow rules can use. */
export const SOFT_NAVIGATION_SUBTYPES = [
  /** `pushState` — a new screen, and a new history entry. */
  "push",
  /** `replaceState` — the same screen rewritten, e.g. a filter or a sort. */
  "replace",
  /** Only the fragment changed — an in-page anchor or a hash router. */
  "hash",
  /** Back, forward, or `history.go` — the user revisiting a screen. */
  "traverse",
  /** No evidence was available to choose between them. */
  "unknown",
] as const;

export type SoftNavigationSubtype = (typeof SOFT_NAVIGATION_SUBTYPES)[number];

/** Which evidence the subtype came from, so a consumer can weigh it. */
export type SubtypeBasis = "navigation_api" | "cdp_label" | "none";

export interface SubtypeInput {
  readonly fromUrl: string | undefined;
  readonly toUrl: string;
  readonly historyIndex: number | undefined;
  readonly historyLength: number | undefined;
  /** The previous observation's position, for comparison. */
  readonly previousIndex: number | undefined;
  readonly previousLength: number | undefined;
  /** Chrome's label. Used only when there is nothing better. */
  readonly cdpNavigationType: string | undefined;
}

export interface SubtypeVerdict {
  readonly subtype: SoftNavigationSubtype;
  readonly basis: SubtypeBasis;
}

/** Whether two URLs differ only in their fragment. */
function fragmentOnly(from: string | undefined, to: string): boolean {
  if (from === undefined) return false;
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.origin !== b.origin || a.pathname !== b.pathname || a.search !== b.search)
      return false;
    return a.hash !== b.hash;
  } catch {
    return false;
  }
}

export function classifySoftNavigation(input: SubtypeInput): SubtypeVerdict {
  const { historyIndex, historyLength, previousIndex, previousLength } = input;

  const haveHistory =
    historyIndex !== undefined &&
    historyLength !== undefined &&
    previousIndex !== undefined &&
    previousLength !== undefined;

  if (haveHistory) {
    if (historyLength > previousLength) {
      // A new entry. Whether it is a route change or an anchor is the one
      // thing history position cannot say, because they move it identically.
      return {
        subtype: fragmentOnly(input.fromUrl, input.toUrl) ? "hash" : "push",
        basis: "navigation_api",
      };
    }
    if (historyIndex !== previousIndex) {
      // Same number of entries, different position: the user moved through
      // history rather than adding to it.
      return { subtype: "traverse", basis: "navigation_api" };
    }
    return { subtype: "replace", basis: "navigation_api" };
  }

  // No Navigation API. Chrome's label is weaker — it cannot separate push from
  // replace, and it calls traversals fragments — but it is what there is, and
  // recording the basis means nobody downstream mistakes it for certainty.
  if (input.cdpNavigationType === "fragment" || fragmentOnly(input.fromUrl, input.toUrl)) {
    return { subtype: "hash", basis: "cdp_label" };
  }
  if (input.cdpNavigationType === "historyApi") {
    return { subtype: "push", basis: "cdp_label" };
  }
  return { subtype: "unknown", basis: "none" };
}
