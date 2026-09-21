/**
 * Which forms are safe to submit — build plan §5A.2, §7.2; dev plan BR-M1-13.
 *
 * This is a safety file. The Explorer submits forms unattended against an
 * application the user owns but may not fully know, and a wrong answer here
 * deletes something. So the rule is inverted from the rest of the tool:
 * **a form is unsafe unless it is recognisably safe**, and every branch that
 * could end in a submission has to justify itself.
 *
 * Three independent gates, all of which must pass:
 *
 *   1. the form's method is in `policy.allowedMethods` (§5A.2)
 *   2. the form is classified `safe`
 *   3. if it is state-changing, `policy.agent.stateChangingActions` is set
 *
 * With the default read-only policy the first gate alone means the Explorer
 * issues no POST at all — which is the acceptance criterion, and worth
 * stating as one: the safest configuration should be safe by arithmetic, not
 * by the classifier being clever.
 */

/** What a form appears to do. */
export const FORM_CLASSES = [
  /** Reads. Search, filter, sort — a GET that changes nothing. */
  "safe_read",
  /** Writes something reversible: a comment, a preference. */
  "state_changing",
  /** Writes something that is not reversible, or costs money. */
  "destructive",
  /** Carries credentials. Never submitted without an auth profile (§12). */
  "authentication",
  /** Nothing in the form said what it does. */
  "unknown",
] as const;

export type FormClass = (typeof FORM_CLASSES)[number];

export interface FormVerdict {
  readonly formClass: FormClass;
  readonly submit: boolean;
  /** One line, recorded per form so a coverage report can explain itself. */
  readonly reason: string;
}

/**
 * Words that make a form destructive whatever else it looks like.
 *
 * Matched against the action path and the submit control's label. Broad on
 * purpose: a false positive costs one unexplored form, a false negative
 * costs whatever the form did.
 */
const DESTRUCTIVE = [
  "delete",
  "remove",
  "destroy",
  "purge",
  "wipe",
  "revoke",
  "deactivate",
  "disable",
  "cancel-subscription",
  "close-account",
  "unsubscribe",
  "logout",
  "signout",
  "sign-out",
  "log-out",
  "reset",
  "transfer",
  "withdraw",
  "pay",
  "payment",
  "checkout",
  "purchase",
  "order",
  "refund",
  "charge",
  "invite",
  "publish",
  "deploy",
  "restart",
  "shutdown",
];

/** Words that mark a form as a search or filter — the only auto-submit case. */
const READ_ONLY = ["search", "filter", "sort", "query", "find", "lookup", "browse"];

export interface FormFacts {
  readonly method: string;
  /** Resolved action URL, or the current page when the form has no action. */
  readonly action: string;
  /** Submit button text or value, lower-cased. */
  readonly submitLabel?: string | undefined;
  readonly fieldNames: readonly string[];
  readonly hasCredentialField: boolean;
  /** Names the user explicitly allow-listed in configuration. */
  readonly allowListed?: boolean | undefined;
}

export interface PolicyView {
  readonly allowedMethods: readonly string[];
  readonly stateChangingActions: boolean;
}

function mentions(haystack: string, words: readonly string[]): string | undefined {
  const lower = haystack.toLowerCase();
  return words.find((word) => lower.includes(word));
}

/** Classify a form. Pure, so the safety matrix is a table test (§36.2). */
export function classifyForm(facts: FormFacts): FormClass {
  if (facts.hasCredentialField) return "authentication";

  const surface = `${facts.action} ${facts.submitLabel ?? ""} ${facts.fieldNames.join(" ")}`;

  // Checked before anything else can call it safe. A form whose action says
  // `/delete` is destructive even if it is a GET and even if its button says
  // "search".
  const destructive = mentions(surface, DESTRUCTIVE);
  if (destructive !== undefined) return "destructive";

  const method = facts.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    // A GET form is a read by HTTP's own definition. A server that writes on
    // GET is broken, and the read-only words below only raise confidence.
    return mentions(surface, READ_ONLY) !== undefined ? "safe_read" : "safe_read";
  }

  return "state_changing";
}

/**
 * Decide whether to submit, and say why either way.
 *
 * The reason is not decoration: §10C's coverage accounting has to explain an
 * unexplored form, and "skipped" without a cause is indistinguishable from a
 * bug.
 */
export function decideSubmission(facts: FormFacts, policy: PolicyView): FormVerdict {
  const formClass = classifyForm(facts);
  const method = facts.method.toUpperCase();

  // Gate 1, and the one that makes the default configuration safe by
  // arithmetic: the default policy allows GET, HEAD and OPTIONS, so a POST
  // form cannot be submitted no matter how the classifier reads it.
  if (!policy.allowedMethods.includes(method)) {
    return {
      formClass,
      submit: false,
      reason: `${method} is not in the policy's allowed methods`,
    };
  }

  if (formClass === "authentication") {
    return {
      formClass,
      submit: false,
      reason: "carries credentials; submitting needs an authentication profile (§12)",
    };
  }

  if (formClass === "destructive") {
    // Not overridable by `stateChangingActions`. That flag permits writes;
    // it is not a licence to delete an account, and conflating the two would
    // make one configuration switch do two very different things.
    return {
      formClass,
      submit: false,
      reason: "the action or its label reads as destructive",
    };
  }

  if (formClass === "state_changing" && !policy.stateChangingActions) {
    return {
      formClass,
      submit: false,
      reason: "changes state, which this policy does not permit",
    };
  }

  if (facts.allowListed === true) {
    return { formClass, submit: true, reason: "explicitly allow-listed in configuration" };
  }

  if (formClass === "safe_read") {
    return {
      formClass,
      submit: true,
      reason: "a read-only form, submitted to reveal its results",
    };
  }

  return { formClass, submit: true, reason: "permitted by policy" };
}

/**
 * A benign value for a field, derived from its name.
 *
 * Deterministic by construction — the same field name always yields the same
 * value — because §36.2 compares two runs and a random string makes every
 * comparison fail. Values are obviously synthetic so that anything they
 * create in the target is recognisable as the tool's doing.
 */
export function synthesizeValue(fieldName: string, type: string): string {
  const name = fieldName.toLowerCase();

  if (type === "email" || name.includes("email")) return "browserrecon@example.invalid";
  if (type === "tel" || name.includes("phone")) return "+10000000000";
  if (type === "url" || name.includes("url") || name.includes("website")) {
    return "https://example.invalid/";
  }
  if (type === "number" || name.includes("qty") || name.includes("quantity")) return "1";
  if (type === "date") return "2020-01-01";
  if (name.includes("search") || name.includes("query") || name.includes("filter")) {
    return "browserrecon";
  }
  if (name.includes("zip") || name.includes("postcode")) return "00000";
  // `.invalid` is reserved by RFC 2606 and can never resolve, so nothing
  // synthesized here can accidentally reach a real address or host.
  return "browserrecon";
}
