/**
 * Deciding whether a click changes application state — build plan §5A.2, §7.4.
 *
 * The Policy Engine refuses state-changing actions unless the policy permits
 * them, but it cannot tell which clicks those are: that needs the DOM, and the
 * engine's own note says the judgment "lives in the browser layer". This is
 * the browser layer, so it is made here.
 *
 * ## Why it is inferred at all, rather than left to the caller
 *
 * `canAct` takes a `stateChanging` flag, and the obvious design is to make the
 * explorer supply it. The problem is the default. A caller that forgets the
 * flag on a delete button gets a permissive answer and the scan deletes
 * something — and "every caller remembers" is not a safety property. Assuming
 * the opposite is no better: defaulting every click to state-changing would
 * make the default read-only policy refuse all clicking, and an explorer that
 * cannot click observes nothing.
 *
 * So the adapter infers a floor and takes whichever answer is stricter. A
 * caller's `true` is never downgraded; a caller's `false` — or silence — can
 * still be overruled by what the element actually is.
 *
 * ## Deliberately blunt
 *
 * This is a safety heuristic, not a classifier. It is allowed to be wrong in
 * the direction of refusing a harmless click; being wrong the other way means
 * submitting a form nobody authorised. The consequence of a false positive is
 * a recorded barrier and slightly less coverage, which §33 already treats as a
 * normal outcome.
 */

/**
 * Words that make an element's own label a strong enough signal on their own.
 *
 * Matched against the accessible name, not the DOM structure, because the
 * dangerous cases are frequently plain buttons wired up by JavaScript with no
 * form anywhere in sight.
 */
const DESTRUCTIVE_WORDS: readonly string[] = [
  "delete",
  "remove",
  "destroy",
  "purge",
  "revoke",
  "deactivate",
  "disable",
  "cancel subscription",
  "close account",
  "submit",
  "confirm",
  "checkout",
  "place order",
  "pay",
  "buy",
  "save",
  "update",
  "publish",
  "send",
  "invite",
  "transfer",
  "reset",
];

/** What the adapter reads off an element before deciding. */
export interface ElementFacts {
  /** Lower-cased tag name. */
  readonly tagName: string;
  /** `type` attribute, for inputs and buttons. */
  readonly type?: string | undefined;
  /** Visible text or accessible name, lower-cased. */
  readonly accessibleName: string;
  /** Whether the element sits inside a `<form>`. */
  readonly inForm: boolean;
  /** `href`, for anchors. */
  readonly href?: string | undefined;
  /** Whether the element declares a non-GET method (form or `formmethod`). */
  readonly nonGetMethod: boolean;
}

export interface StateChangeVerdict {
  readonly stateChanging: boolean;
  /** Why, in one phrase — goes into the denial a user reads. */
  readonly because: string;
}

/** The adapter's own read on whether clicking this element changes state. */
export function inferStateChanging(facts: ElementFacts): StateChangeVerdict {
  // An element we could not read is an element we cannot vouch for. Refusing
  // costs a recorded barrier and a little coverage, which §33 treats as a
  // normal outcome; guessing "harmless" costs whatever the click did. Added
  // after a bug returned malformed facts and this function threw instead —
  // crashing the scan on an unreadable button is the worst of the three
  // outcomes.
  if (typeof facts?.accessibleName !== "string" || typeof facts.tagName !== "string") {
    return { stateChanging: true, because: "the element could not be inspected" };
  }

  if (facts.nonGetMethod) {
    return { stateChanging: true, because: "submits a form with a non-GET method" };
  }

  if (facts.tagName === "button" && (facts.type ?? "submit") === "submit" && facts.inForm) {
    // A <button> inside a form defaults to type=submit, which is the single
    // most common way a click becomes a write.
    return { stateChanging: true, because: "is a submit button inside a form" };
  }

  if (facts.tagName === "input" && (facts.type === "submit" || facts.type === "image")) {
    return { stateChanging: true, because: "is a form submit control" };
  }

  const word = DESTRUCTIVE_WORDS.find((candidate) => facts.accessibleName.includes(candidate));
  if (word !== undefined) {
    return { stateChanging: true, because: `is labelled "${word}"` };
  }

  if (facts.href !== undefined && /[?&](delete|remove|confirm|token)=/i.test(facts.href)) {
    // A GET link that performs a write is bad practice and common. The query
    // string is the only evidence available before clicking it.
    return { stateChanging: true, because: "links to a URL that looks like an action" };
  }

  return { stateChanging: false, because: "no state-changing signal" };
}

/**
 * Combine the caller's declaration with the adapter's own.
 *
 * Strictest wins, in both directions — a caller that knows more than the DOM
 * shows can still force `true`.
 */
export function resolveStateChanging(
  declared: boolean | undefined,
  inferred: StateChangeVerdict,
): StateChangeVerdict {
  if (declared === true) {
    return { stateChanging: true, because: "the caller declared it state-changing" };
  }
  return inferred;
}
