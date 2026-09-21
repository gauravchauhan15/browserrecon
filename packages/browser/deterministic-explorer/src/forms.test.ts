import { describe, expect, it } from "vitest";
import {
  classifyForm,
  decideSubmission,
  synthesizeValue,
  type FormFacts,
  type PolicyView,
} from "./forms.js";

/**
 * The safety matrix. This is the test that matters most in the package: a
 * wrong answer here means the Explorer deletes something unattended.
 */

const form = (overrides: Partial<FormFacts> = {}): FormFacts => ({
  method: "GET",
  action: "https://app.test/search",
  submitLabel: "search",
  fieldNames: ["q"],
  hasCredentialField: false,
  ...overrides,
});

const readOnly: PolicyView = {
  allowedMethods: ["GET", "HEAD", "OPTIONS"],
  stateChangingActions: false,
};
const permissive: PolicyView = {
  allowedMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"],
  stateChangingActions: true,
};

describe("the default policy is safe by arithmetic", () => {
  it("issues no POST at all, whatever the classifier thinks", async () => {
    // The acceptance criterion, and deliberately not a property of the
    // classifier being clever: the default policy allows GET, HEAD and
    // OPTIONS, so a POST form cannot be submitted by any path through this.
    for (const label of ["search", "filter", "subscribe", "save preferences"]) {
      const verdict = decideSubmission(
        form({ method: "POST", submitLabel: label, action: "https://app.test/x" }),
        readOnly,
      );
      expect(verdict.submit, label).toBe(false);
      expect(verdict.reason).toContain("not in the policy's allowed methods");
    }
  });
});

describe("forms that must never be submitted", () => {
  it.each([
    ["/account/delete", "delete"],
    ["/users/1/remove", "remove"],
    ["/api/revoke-token", "revoke"],
    ["/logout", "logout"],
    ["/checkout/pay", "pay"],
    ["/orders/refund", "refund"],
    ["/subscription/cancel-subscription", "cancel"],
    ["/deploy", "deploy"],
  ])("refuses %s even under a permissive policy", (action) => {
    // `stateChangingActions` permits writes; it is not a licence to delete an
    // account. Conflating the two would make one switch do two very
    // different things.
    const verdict = decideSubmission(form({ method: "POST", action }), permissive);
    expect(verdict.submit).toBe(false);
    expect(verdict.formClass).toBe("destructive");
  });

  it("reads the submit label as well as the action", async () => {
    const verdict = decideSubmission(
      form({ method: "POST", action: "https://app.test/x", submitLabel: "delete forever" }),
      permissive,
    );
    expect(verdict.submit).toBe(false);
  });

  it("refuses a destructive GET, because a broken server is still a server", async () => {
    // A GET that deletes is bad practice and common. HTTP's definition does
    // not protect the user from an application that ignores it.
    const verdict = decideSubmission(
      form({ method: "GET", action: "https://app.test/items/4/delete" }),
      readOnly,
    );
    expect(verdict.submit).toBe(false);
    expect(verdict.formClass).toBe("destructive");
  });

  it("never submits a credential form", async () => {
    const verdict = decideSubmission(
      form({ method: "POST", hasCredentialField: true, action: "https://app.test/login" }),
      permissive,
    );
    expect(verdict.submit).toBe(false);
    expect(verdict.formClass).toBe("authentication");
    expect(verdict.reason).toContain("authentication profile");
  });
});

describe("forms that may be submitted", () => {
  it("submits a search form under the default policy", async () => {
    const verdict = decideSubmission(form(), readOnly);
    expect(verdict.submit).toBe(true);
    expect(verdict.formClass).toBe("safe_read");
  });

  it("submits an ordinary write only when the policy permits writes", async () => {
    const write = form({
      method: "POST",
      action: "https://app.test/comments",
      submitLabel: "post comment",
    });
    expect(
      decideSubmission(write, { ...readOnly, allowedMethods: ["GET", "POST"] }).submit,
    ).toBe(false);
    expect(decideSubmission(write, permissive).submit).toBe(true);
  });

  it("honours an explicit allow-list", async () => {
    const verdict = decideSubmission(
      form({ method: "POST", action: "https://app.test/comments", allowListed: true }),
      permissive,
    );
    expect(verdict.submit).toBe(true);
    expect(verdict.reason).toContain("allow-listed");
  });

  it("does not let an allow-list override destructive", async () => {
    // A user allow-listing a form has said "this one is fine"; they have not
    // said "ignore the word delete in its action".
    const verdict = decideSubmission(
      form({ method: "POST", action: "https://app.test/delete-all", allowListed: true }),
      permissive,
    );
    expect(verdict.submit).toBe(false);
  });
});

describe("every decision is explained", () => {
  it("gives a reason whether it submits or not", async () => {
    // §10C's coverage accounting has to explain an unexplored form, and
    // "skipped" without a cause is indistinguishable from a bug.
    for (const facts of [
      form(),
      form({ method: "POST" }),
      form({ hasCredentialField: true }),
      form({ action: "/delete" }),
    ]) {
      expect(decideSubmission(facts, readOnly).reason.length).toBeGreaterThan(10);
    }
  });
});

describe("synthesized values", () => {
  it("is deterministic, because golden output compares two runs", async () => {
    for (const name of ["q", "email", "quantity", "unknown_field"]) {
      const first = synthesizeValue(name, "text");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect(synthesizeValue(name, "text")).toBe(first);
      }
    }
  });

  it("can never reach a real address or host", async () => {
    // RFC 2606 reserves `.invalid`, so nothing typed into a form can
    // accidentally email a person or call out to a domain someone owns.
    expect(synthesizeValue("email", "email")).toContain(".invalid");
    expect(synthesizeValue("website", "url")).toContain(".invalid");
  });

  it("is obviously synthetic, so anything it creates is recognisable", async () => {
    expect(synthesizeValue("comment", "text")).toBe("browserrecon");
  });

  it("matches the field's shape where it can", async () => {
    expect(synthesizeValue("qty", "number")).toBe("1");
    expect(synthesizeValue("when", "date")).toBe("2020-01-01");
    expect(synthesizeValue("q", "search")).toBe("browserrecon");
  });
});
