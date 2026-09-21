import { describe, expect, it } from "vitest";
import { SOFT_NAVIGATION_SUBTYPES, classifySoftNavigation, type SubtypeInput } from "./kind.js";

const at = (overrides: Partial<SubtypeInput> = {}): SubtypeInput => ({
  fromUrl: "https://app.test/app/home",
  toUrl: "https://app.test/app/orders",
  historyIndex: 1,
  historyLength: 2,
  previousIndex: 0,
  previousLength: 1,
  cdpNavigationType: "historyApi",
  ...overrides,
});

describe("separating the four kinds of route change", () => {
  it("reads a new entry at a new index as a push", async () => {
    const verdict = classifySoftNavigation(at());
    expect(verdict).toEqual({ subtype: "push", basis: "navigation_api" });
  });

  it("reads an unchanged index and length as a replace", async () => {
    // What a filter or a sort control does. Counting it as a new screen would
    // double every list view in the model.
    const verdict = classifySoftNavigation(
      at({ historyIndex: 1, historyLength: 2, previousIndex: 1, previousLength: 2 }),
    );
    expect(verdict).toEqual({ subtype: "replace", basis: "navigation_api" });
  });

  it("reads a moved index with the same length as a traversal", async () => {
    // Back and forward. CDP calls this a fragment change even when the path
    // moves, which is why the history position is what decides.
    for (const index of [0, 2]) {
      const verdict = classifySoftNavigation(
        at({
          historyIndex: index,
          historyLength: 3,
          previousIndex: 1,
          previousLength: 3,
          cdpNavigationType: "fragment",
        }),
      );
      expect(verdict.subtype, `index ${index}`).toBe("traverse");
    }
  });

  it("reads a new entry that only changes the fragment as a hash change", async () => {
    // A push and a hash change move history identically, so the URLs are what
    // separate them.
    const verdict = classifySoftNavigation(
      at({
        fromUrl: "https://app.test/app/orders",
        toUrl: "https://app.test/app/orders#details",
        cdpNavigationType: "fragment",
      }),
    );
    expect(verdict).toEqual({ subtype: "hash", basis: "navigation_api" });
  });

  it("does not call a path change a hash change just because a fragment appeared", async () => {
    const verdict = classifySoftNavigation(
      at({ fromUrl: "https://app.test/a", toUrl: "https://app.test/b#x" }),
    );
    expect(verdict.subtype).toBe("push");
  });
});

describe("when Chrome's label is all there is", () => {
  // A sandboxed frame, or a Chrome without the Navigation API. The answer is
  // weaker, and the basis says so, so nothing downstream mistakes it for
  // certainty.
  const noHistory = {
    historyIndex: undefined,
    historyLength: undefined,
    previousIndex: undefined,
    previousLength: undefined,
  };

  it("falls back to the label and records that it did", async () => {
    const verdict = classifySoftNavigation(
      at({ ...noHistory, cdpNavigationType: "historyApi" }),
    );
    expect(verdict).toEqual({ subtype: "push", basis: "cdp_label" });
  });

  it("cannot tell a replace from a push without the history position", async () => {
    // Stated as a test rather than a comment: both come back as `push`, and
    // the basis is the only warning a consumer gets.
    const verdict = classifySoftNavigation(
      at({ ...noHistory, cdpNavigationType: "historyApi" }),
    );
    expect(verdict.subtype).not.toBe("replace");
    expect(verdict.basis).toBe("cdp_label");
  });

  it("still recognises a fragment-only change from the URLs alone", async () => {
    const verdict = classifySoftNavigation(
      at({
        ...noHistory,
        fromUrl: "https://app.test/a",
        toUrl: "https://app.test/a#section",
        cdpNavigationType: undefined,
      }),
    );
    expect(verdict.subtype).toBe("hash");
  });

  it("says unknown rather than guessing", async () => {
    const verdict = classifySoftNavigation(
      at({ ...noHistory, cdpNavigationType: undefined, fromUrl: undefined }),
    );
    expect(verdict).toEqual({ subtype: "unknown", basis: "none" });
  });
});

describe("awkward inputs", () => {
  it("copes with a first navigation that has no previous URL", async () => {
    expect(classifySoftNavigation(at({ fromUrl: undefined })).subtype).toBe("push");
  });

  it("copes with URLs it cannot parse", async () => {
    const verdict = classifySoftNavigation(
      at({ fromUrl: "not a url", toUrl: "also not a url" }),
    );
    expect(SOFT_NAVIGATION_SUBTYPES as readonly string[]).toContain(verdict.subtype);
  });

  it("always returns a subtype from the published set", async () => {
    for (const type of ["historyApi", "fragment", "other", undefined]) {
      const verdict = classifySoftNavigation(at({ cdpNavigationType: type }));
      expect(SOFT_NAVIGATION_SUBTYPES as readonly string[]).toContain(verdict.subtype);
    }
  });
});
