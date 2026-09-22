/**
 * Deciding what to click — build plan §5A, §5A.2, §9.4; dev plan BR-M3-pre.
 *
 * A workflow is mostly *interaction → requests*. A scan that only navigates
 * sees a site's front doors and none of its rooms: the checkout call fires on
 * a click, the admin chunk loads on a click, and the API a page uses to do
 * its actual work is behind one. Until this existed, every request a scan
 * observed was load-initiated, and `interaction_id` was a field nothing ever
 * filled.
 *
 * ## Refusing is the default, and the reasons are recorded
 *
 * Every control gets a verdict with a cause. §10C's coverage accounting has
 * to explain an unexplored control, and "skipped" without a reason is
 * indistinguishable from a bug — a reader cannot tell "we chose not to" from
 * "we failed to".
 *
 * ## The form decides, not the button
 *
 * A submit button is a click; what it does is submit the form it belongs to.
 * So a submit control is passed to `decideSubmission`, which applies §5A.2's
 * three gates — and the first of those checks destructiveness *before*
 * anything can call the form safe. A button reading "Continue" that posts to
 * `/api/next` with an `amount_cents` field is refused on the form's evidence,
 * not the button's label.
 *
 * ## Deterministic, because a workflow has to be comparable across runs
 *
 * Controls are taken in document order, bounded per page. No sampling, no
 * randomness: two scans of the same page press the same buttons in the same
 * order, or §36.2's golden comparison is worthless and M3's workflow
 * detection has nothing stable to detect.
 */
import type { HarvestedControl, HarvestedForm } from "@browserrecon/browser-adapter";
import { decideSubmission, type PolicyView } from "@browserrecon/deterministic-explorer";

export const SKIP_REASONS = [
  "destructive_form",
  "state_changing_form",
  "authentication_form",
  "method_not_allowed",
  "destructive_label",
  "navigates_away",
  "budget_exhausted",
  "already_pressed",
  "no_reference",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export type ControlVerdict =
  | { readonly press: true; readonly selector: string; readonly label: string }
  | { readonly press: false; readonly reason: SkipReason; readonly detail: string };

/**
 * Words that make a control destructive on its own evidence.
 *
 * A button outside any form, wired to a script, whose label says "Delete
 * account". There is no form to classify, so the label is all there is —
 * and unlike §5A.2's form gates, a false positive here costs one click.
 */
const DESTRUCTIVE_LABEL =
  /\b(?:delete|remove|destroy|erase|wipe|purge|revoke|deactivate|terminate|cancel subscription|close account|reset|clear all|unsubscribe|log ?out|sign ?out)\b/i;

/**
 * Logging out is not destructive, but it ends the session mid-scan.
 *
 * Kept in the list above rather than given its own category: the action to
 * take is identical, and §7.1's default exclusions already refuse `/logout`
 * as a URL. This is the same rule reaching the button that leads there.
 */

export interface DecideOptions {
  readonly policy: PolicyView;
  /** Controls already pressed on this page, by selector. */
  readonly pressed: ReadonlySet<string>;
  /** How many more may be pressed on this page. */
  readonly remaining: number;
  /** Turns element facts into a selector. Injected so this stays pure. */
  readonly reference: (
    control: HarvestedControl,
  ) => { selector: string; label?: string | undefined } | undefined;
}

/** What a form is worth, as `decideSubmission` needs it. */
function factsFor(form: HarvestedForm, pageUrl: string) {
  const fieldNames = form.fields.map((field) => field.name).filter((name) => name !== "");
  return {
    method: form.method,
    action: form.action === "" ? pageUrl : form.action,
    ...(form.submitText === undefined ? {} : { submitLabel: form.submitText.toLowerCase() }),
    fieldNames,
    hasCredentialField: form.fields.some((field) =>
      /password|passwd|otp|totp|mfa|2fa|secret|token/i.test(`${field.name} ${field.type}`),
    ),
  };
}

export function decideControl(
  control: HarvestedControl,
  pageUrl: string,
  options: DecideOptions,
): ControlVerdict {
  if (options.remaining <= 0) {
    return {
      press: false,
      reason: "budget_exhausted",
      detail: "the per-page interaction budget is spent",
    };
  }

  const label = control.facts.accessibleName;

  // Before anything else. A control whose own label says it destroys
  // something is refused whether or not a form is involved, and whether or
  // not the policy would otherwise permit it.
  const destructive = DESTRUCTIVE_LABEL.exec(label);
  if (destructive !== null) {
    return {
      press: false,
      reason: "destructive_label",
      detail: `the control reads "${label}", which names a destructive action`,
    };
  }

  // A submit control is a form submission. The form's evidence decides —
  // §5A.2's first gate checks destructiveness before anything can call it
  // safe, which is what catches a "Continue" button that posts a transfer.
  if (control.submitsForm !== undefined) {
    const facts = factsFor(control.submitsForm, pageUrl);
    const verdict = decideSubmission(facts, options.policy);
    if (!verdict.submit) {
      const reason: SkipReason =
        verdict.formClass === "destructive"
          ? "destructive_form"
          : verdict.formClass === "authentication"
            ? "authentication_form"
            : options.policy.allowedMethods.includes(facts.method.toUpperCase())
              ? "state_changing_form"
              : "method_not_allowed";
      return { press: false, reason, detail: verdict.reason };
    }
  }

  const built = options.reference(control);
  if (built === undefined) {
    // No stable handle. Clicking by position would press whatever happens to
    // be there on a page that has since changed, which is worse than not
    // clicking: the interaction would be recorded against the wrong element.
    return {
      press: false,
      reason: "no_reference",
      detail: "no stable selector could be derived",
    };
  }

  if (options.pressed.has(built.selector)) {
    return {
      press: false,
      reason: "already_pressed",
      detail: `${built.selector} was already pressed`,
    };
  }

  return { press: true, selector: built.selector, label: built.label ?? label };
}

/** One control and what was decided about it, for the coverage record. */
export interface ControlOutcome {
  readonly selector?: string | undefined;
  readonly label: string;
  readonly pressed: boolean;
  readonly reason?: SkipReason | undefined;
  readonly detail?: string | undefined;
}
