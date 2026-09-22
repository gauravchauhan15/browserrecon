import { describe, expect, it } from "vitest";
import { decideControl, type ControlVerdict } from "./index.js";
import type { HarvestedControl, HarvestedForm } from "@browserrecon/browser-adapter";

const READ_ONLY = { allowedMethods: ["GET", "HEAD", "OPTIONS"], stateChangingActions: false };

function control(
  over: Partial<HarvestedControl["facts"]> = {},
  submitsForm?: HarvestedForm,
): HarvestedControl {
  return {
    index: 0,
    facts: {
      tagName: "button",
      accessibleName: "continue",
      inForm: submitsForm !== undefined,
      nonGetMethod: (submitsForm?.method ?? "GET") !== "GET",
      id: "the-button",
      classes: [],
      ancestors: [],
      ...over,
    },
    ...(submitsForm === undefined ? {} : { submitsForm }),
  };
}

const form = (over: Partial<HarvestedForm> = {}): HarvestedForm => ({
  method: "POST",
  action: "https://shop.example.com/api/next",
  fields: [],
  ...over,
});

const decide = (
  subject: HarvestedControl,
  over: Partial<Parameters<typeof decideControl>[2]> = {},
): ControlVerdict =>
  decideControl(subject, "https://shop.example.com/", {
    policy: READ_ONLY,
    pressed: new Set(),
    remaining: 5,
    reference: (c) => ({ selector: `#${c.facts.id ?? "x"}`, label: c.facts.accessibleName }),
    ...over,
  });

describe("what gets pressed", () => {
  it("presses an ordinary button", () => {
    const verdict = decide(control({ accessibleName: "load more" }));
    expect(verdict.press).toBe(true);
  });

  it("presses a safe GET form's submit", () => {
    // A search or filter form is how a scan reaches a lot of surface, and
    // §5A.2 classifies a GET form `safe_read`.
    const verdict = decide(
      control({ accessibleName: "search" }, form({ method: "GET", action: "/search" })),
    );
    expect(verdict.press).toBe(true);
  });
});

describe("what does not, and why", () => {
  const refusal = (verdict: ControlVerdict) => (verdict.press ? undefined : verdict);

  it("refuses a control whose own label names a destructive action", () => {
    // No form to classify — the label is all there is, and unlike §5A.2's
    // form gates a false positive here costs one click.
    for (const label of [
      "delete my account",
      "remove item",
      "revoke access",
      "deactivate",
      "close account",
      "log out",
    ]) {
      const verdict = decide(control({ accessibleName: label }));
      expect(refusal(verdict)?.reason, label).toBe("destructive_label");
    }
  });

  it("refuses a destructive form even when its button is innocuous", () => {
    // The case forms-site exists for: a button reading "Continue" that posts
    // a transfer. §5A.2's first gate checks destructiveness before anything
    // can call the form safe.
    const verdict = decide(
      control(
        { accessibleName: "continue" },
        form({ action: "https://shop.example.com/api/account/delete" }),
      ),
    );
    expect(refusal(verdict)?.reason).toBe("destructive_form");
  });

  it("refuses a POST form under a read-only policy", () => {
    const verdict = decide(control({ accessibleName: "subscribe" }, form()));
    expect(refusal(verdict)?.reason).toBe("method_not_allowed");
  });

  it("refuses a login form", () => {
    const verdict = decide(
      control(
        { accessibleName: "sign in" },
        form({ action: "/session", fields: [{ name: "password", type: "password" }] }),
      ),
    );
    expect(refusal(verdict)?.reason).toBe("authentication_form");
  });

  it("refuses a control with no stable handle", () => {
    // Clicking by position would press whatever happens to be there on a page
    // that has since changed — recording the interaction against the wrong
    // element, which is worse than not clicking.
    const verdict = decide(control(), { reference: () => undefined });
    expect(refusal(verdict)?.reason).toBe("no_reference");
  });

  it("refuses one already pressed", () => {
    const verdict = decide(control(), { pressed: new Set(["#the-button"]) });
    expect(refusal(verdict)?.reason).toBe("already_pressed");
  });

  it("refuses once the per-page budget is spent", () => {
    // A page of forty buttons would otherwise consume the whole scan.
    const verdict = decide(control(), { remaining: 0 });
    expect(refusal(verdict)?.reason).toBe("budget_exhausted");
  });

  it("states a cause for every refusal", () => {
    // §10C's coverage accounting has to explain an unexplored control.
    // "Skipped" with no cause is indistinguishable from a bug — a reader
    // cannot tell "we chose not to" from "we failed to".
    for (const subject of [
      control({ accessibleName: "delete" }),
      control({ accessibleName: "go" }, form()),
      control(),
    ]) {
      const verdict = decide(subject, { remaining: 0 });
      expect(refusal(verdict)?.detail.length, subject.facts.accessibleName).toBeGreaterThan(10);
    }
  });
});

describe("ordering", () => {
  it("checks the destructive label before anything else", () => {
    // Before the budget, before the form, before the selector. A control
    // that says it deletes something is refused even when every other gate
    // would have refused it anyway — so the recorded reason is the true one.
    const verdict = decide(
      control({ accessibleName: "delete everything" }, form({ method: "GET" })),
      { reference: () => undefined },
    );
    expect(verdict.press).toBe(false);
    if (verdict.press) return;
    expect(verdict.reason).toBe("destructive_label");
  });
});
