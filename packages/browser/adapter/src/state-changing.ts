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

/**
 * One step up the ancestor chain, as the DOM reports it.
 *
 * Captured so a *structural* selector can be built without a second round
 * trip: by the time anything wants one, the page may have moved on, and an
 * element read after the fact is not the element that was clicked.
 */
export interface AncestorStep {
  readonly tagName: string;
  readonly id?: string | undefined;
  /** Class list, in document order. */
  readonly classes: readonly string[];
  /** Position among same-tag siblings, from 1 — what `:nth-of-type` takes. */
  readonly nthOfType: number;
  /** True when this element is the only one of its tag among its siblings. */
  readonly uniqueOfType: boolean;
  /** `data-testid` and friends, which exist precisely to be stable. */
  readonly testId?: string | undefined;
}

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

  // --- Identity, for the interaction collector (BR-M1-08) -----------------
  //
  // Read here rather than derived here. Turning these into a selector is a
  // pure function over facts, and keeping it out of the browser layer makes
  // it testable without one — which matters, because "reproducible across
  // runs" is a property of the derivation, not of the DOM read.

  readonly id?: string | undefined;
  readonly classes?: readonly string[] | undefined;
  readonly testId?: string | undefined;
  /** `name`, which form controls are addressed by. */
  readonly name?: string | undefined;
  readonly role?: string | undefined;
  /** The element and its ancestors, nearest first, up to a bounded depth. */
  readonly ancestors?: readonly AncestorStep[] | undefined;
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

  const isSubmitControl =
    (facts.tagName === "button" && (facts.type ?? "submit") === "submit" && facts.inForm) ||
    (facts.tagName === "input" && (facts.type === "submit" || facts.type === "image"));

  if (isSubmitControl) {
    // A submit control in a form whose method is GET is a read. HTTP says so,
    // and §5A.2's `classifyForm` says so in as many words: "a GET form is a
    // read by HTTP's own definition. A server that writes on GET is broken."
    //
    // This used to return `stateChanging` for every submit control, which
    // made the two halves of the codebase disagree — the explorer classified
    // a search form `safe_read` and decided to submit it, and then the
    // adapter refused the click. The cost was silent: search and filter
    // forms, which are how a scan reaches a lot of surface, were never
    // submitted and nothing recorded why.
    //
    // The residual risk is a server that writes on a GET form. That server is
    // broken, the destructive-word check below still refuses anything that
    // *looks* like a write, and §5A.2 already accepts this exact risk. What
    // is not acceptable is two components disagreeing about it.
    if (facts.nonGetMethod || !facts.inForm) {
      return { stateChanging: true, because: "is a form submit control" };
    }
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
