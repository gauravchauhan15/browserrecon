import { describe, expect, it } from "vitest";
import {
  inferStateChanging,
  resolveStateChanging,
  type ElementFacts,
} from "./state-changing.js";

const element = (overrides: Partial<ElementFacts> = {}): ElementFacts => ({
  tagName: "a",
  accessibleName: "read more",
  inForm: false,
  nonGetMethod: false,
  ...overrides,
});

describe("what counts as state-changing", () => {
  it("treats a non-GET form as state-changing whatever it is labelled", async () => {
    const verdict = inferStateChanging(
      element({ tagName: "button", nonGetMethod: true, accessibleName: "go" }),
    );
    expect(verdict.stateChanging).toBe(true);
    expect(verdict.because).toContain("non-GET");
  });

  it("treats a bare <button> in a form as a submit, because HTML does", async () => {
    // <button> defaults to type=submit inside a form. The single most common
    // way a click becomes a write, and the easiest to miss.
    expect(
      inferStateChanging(element({ tagName: "button", inForm: true, accessibleName: "go" }))
        .stateChanging,
    ).toBe(true);
  });

  it("does not treat a type=button in a form as a submit", async () => {
    expect(
      inferStateChanging(
        element({ tagName: "button", type: "button", inForm: true, accessibleName: "open" }),
      ).stateChanging,
    ).toBe(false);
  });

  it("reads the label, because the dangerous cases are often plain buttons", async () => {
    // A delete button wired up by JavaScript has no form anywhere in sight.
    for (const label of ["delete account", "Remove item", "revoke token", "place order"]) {
      const verdict = inferStateChanging(
        element({ tagName: "button", type: "button", accessibleName: label.toLowerCase() }),
      );
      expect(verdict.stateChanging, `"${label}" read as safe`).toBe(true);
    }
  });

  it("leaves ordinary navigation alone", async () => {
    // A heuristic that flags everything makes the read-only policy refuse all
    // clicking, and an explorer that cannot click observes nothing.
    for (const label of ["read more", "about us", "next page", "products", "view details"]) {
      expect(inferStateChanging(element({ accessibleName: label })).stateChanging, label).toBe(
        false,
      );
    }
  });

  it("catches a GET link that performs an action", async () => {
    // Bad practice and extremely common. The query string is the only
    // evidence available before clicking it.
    expect(
      inferStateChanging(element({ href: "/items/12?delete=1", accessibleName: "x" }))
        .stateChanging,
    ).toBe(true);
  });

  it("says why, so the denial a user reads is actionable", async () => {
    const verdict = inferStateChanging(
      element({ tagName: "button", type: "button", accessibleName: "delete forever" }),
    );
    expect(verdict.because).toContain("delete");
  });
});

describe("combining the caller's view with the adapter's", () => {
  it("takes the caller's word when it is stricter", async () => {
    const verdict = resolveStateChanging(true, inferStateChanging(element()));
    expect(verdict.stateChanging).toBe(true);
  });

  it("overrules a caller who says a delete button is harmless", async () => {
    // The whole reason the adapter infers at all: "every caller remembers to
    // pass the flag" is not a safety property.
    const facts = element({ tagName: "button", type: "button", accessibleName: "delete user" });
    expect(resolveStateChanging(false, inferStateChanging(facts)).stateChanging).toBe(true);
  });

  it("overrules a caller who says nothing at all", async () => {
    const facts = element({ tagName: "button", inForm: true, accessibleName: "go" });
    expect(resolveStateChanging(undefined, inferStateChanging(facts)).stateChanging).toBe(true);
  });
});
