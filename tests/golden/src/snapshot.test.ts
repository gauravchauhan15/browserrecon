import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_ENV, compareToBaseline, expectGolden, renderDiff } from "./snapshot.js";
import { normalizeJson, type NormalizeResult } from "./normalize.js";
import type { GoldenEnvironment } from "./snapshot.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "br-golden-"));

/** A baseline directory with the update flag off, as a normal test run sees it. */
const reading = (dir: string): GoldenEnvironment => ({ dir, env: {} });
/** The same directory as `pnpm test:golden:update` sees it. */
const updating = (dir: string): GoldenEnvironment => ({ dir, env: { [UPDATE_ENV]: "1" } });

const result = (value: unknown): NormalizeResult => normalizeJson(value);

describe("a missing baseline", () => {
  it("fails instead of creating one", async () => {
    // The design decision this whole file exists to protect. Auto-creating a
    // baseline blesses whatever the code does today, and the commit that does
    // it looks like a passing test run.
    const dir = scratch();
    const outcome = compareToBaseline("first", result({ a: 1 }), reading(dir));

    expect(outcome.status).toBe("missing");
    expect(existsSync(join(dir, "first.golden.txt"))).toBe(false);
  });

  it("says exactly how to create one", async () => {
    const outcome = compareToBaseline("first", result({ a: 1 }), reading(scratch()));
    expect(outcome.status === "missing" && outcome.message).toContain(
      "pnpm test:golden:update",
    );
  });

  it("is created only when a human asks", async () => {
    const dir = scratch();
    const outcome = compareToBaseline("first", result({ a: 1 }), updating(dir));

    expect(outcome).toMatchObject({ status: "written", created: true });
    expect(existsSync(join(dir, "first.golden.txt"))).toBe(true);
  });
});

describe("comparison", () => {
  it("matches a baseline it just recorded", async () => {
    const dir = scratch();
    compareToBaseline("same", result({ a: 1, b: [2, 3] }), updating(dir));

    expect(compareToBaseline("same", result({ a: 1, b: [2, 3] }), reading(dir)).status).toBe(
      "matched",
    );
  });

  it("detects a changed value — the false-negative case", async () => {
    // If this can be made to pass while the content differs, every golden test
    // in the repo is decorative.
    const dir = scratch();
    compareToBaseline("changed", result({ status: 200 }), updating(dir));

    const outcome = compareToBaseline("changed", result({ status: 500 }), reading(dir));
    expect(outcome.status).toBe("differs");
    expect(outcome.status === "differs" && outcome.diff).toContain("500");
  });

  it("detects a removed field, not just a changed one", async () => {
    const dir = scratch();
    compareToBaseline("dropped", result({ keep: 1, drop: 2 }), updating(dir));

    const outcome = compareToBaseline("dropped", result({ keep: 1 }), reading(dir));
    expect(outcome.status).toBe("differs");
  });

  it("detects a reordered array, because order is behaviour", async () => {
    const dir = scratch();
    compareToBaseline("order", result({ steps: ["a", "b"] }), updating(dir));

    expect(compareToBaseline("order", result({ steps: ["b", "a"] }), reading(dir)).status).toBe(
      "differs",
    );
  });

  it("does not fire on a legitimately varying field — the false-positive case", async () => {
    // Two runs minutes apart, differing only in the fields that must differ.
    const dir = scratch();
    compareToBaseline(
      "varying",
      result({ timestamp: "2026-09-11T08:00:00.000Z", durationMs: 41, status: 200 }),
      updating(dir),
    );

    const outcome = compareToBaseline(
      "varying",
      result({ timestamp: "2026-09-11T09:17:22.913Z", durationMs: 3308, status: 200 }),
      reading(dir),
    );
    expect(outcome.status).toBe("matched");
  });

  it("fires when masking starts hiding more than it used to", async () => {
    // The over-masking defence. Content is identical after normalization, but
    // the recorded mask counts changed, so the baseline differs and a reviewer
    // is asked about it.
    const dir = scratch();
    compareToBaseline("coverage", result({ a: 1 }), updating(dir));

    const outcome = compareToBaseline(
      "coverage",
      { text: normalizeJson({ a: 1 }).text, report: { timestamp: 17 } },
      reading(dir),
    );
    expect(outcome.status).toBe("differs");
    expect(outcome.status === "differs" && outcome.diff).toContain("timestamp: 17");
  });

  it("records the mask report in the baseline file itself", async () => {
    const dir = scratch();
    compareToBaseline(
      "report",
      result({ timestamp: "2026-09-11T08:00:00.000Z" }),
      updating(dir),
    );

    const written = readFileSync(join(dir, "report.golden.txt"), "utf8");
    expect(written).toContain("#   timestamp: 1");
    expect(written).toContain("pnpm test:golden:update");
  });

  it("says nothing was masked when nothing was", async () => {
    const dir = scratch();
    compareToBaseline("clean", result({ a: 1 }), updating(dir));
    expect(readFileSync(join(dir, "clean.golden.txt"), "utf8")).toContain("(nothing masked)");
  });
});

describe("the update flow", () => {
  it("rewrites an existing baseline when asked", async () => {
    const dir = scratch();
    compareToBaseline("rewrite", result({ v: 1 }), updating(dir));

    const outcome = compareToBaseline("rewrite", result({ v: 2 }), updating(dir));
    expect(outcome).toMatchObject({ status: "written", created: false });
    expect(readFileSync(join(dir, "rewrite.golden.txt"), "utf8")).toContain('"v": 2');
  });

  it("refuses to update under CI even with the flag set", async () => {
    // Otherwise the entire guarantee rests on nobody adding the variable to a
    // workflow file, and a job that rewrites its own expectations always
    // passes.
    const dir = scratch();
    compareToBaseline("ci", result({ v: 1 }), updating(dir));

    const outcome = compareToBaseline("ci", result({ v: 2 }), {
      dir,
      env: { [UPDATE_ENV]: "1", CI: "true" },
    });

    expect(outcome.status).toBe("differs");
    expect(outcome.status === "differs" && outcome.message).toContain("Refusing to rewrite");
    expect(readFileSync(join(dir, "ci.golden.txt"), "utf8")).toContain('"v": 1');
  });

  it("treats an explicitly disabled flag as off", async () => {
    // `BROWSERRECON_UPDATE_GOLDEN=0` must not read as "set, therefore update".
    const dir = scratch();
    for (const value of ["", "0", "false"]) {
      expect(
        compareToBaseline("off", result({ v: 1 }), { dir, env: { [UPDATE_ENV]: value } })
          .status,
        `flag value ${JSON.stringify(value)}`,
      ).toBe("missing");
    }
  });
});

describe("diff readability", () => {
  it("points at the first differing line and counts the rest", async () => {
    const before = ["same", "same", "old-a", "old-b", "tail"].join("\n");
    const after = ["same", "same", "new-a", "new-b", "tail"].join("\n");
    const diff = renderDiff(before, after);

    expect(diff).toContain("2 line(s) differ, starting at line 3");
    expect(diff).toContain("  - old-a");
    expect(diff).toContain("  + new-a");
    // Unchanged context is trimmed, or a thousand-line log buries the change.
    expect(diff).not.toContain("  - same");
  });

  it("bounds the output when a field is added to every record", async () => {
    // The realistic schema change: every line differs. A full dump is not a
    // review aid.
    const before = Array.from({ length: 500 }, (_, i) => `{"id":${i}}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `{"id":${i},"new":true}`).join("\n");
    const diff = renderDiff(before, after);

    expect(diff).toContain("500 line(s) differ");
    expect(diff).toContain("further differing line(s) not shown");
    expect(diff.split("\n").length).toBeLessThan(100);
  });

  it("shows an added line with no counterpart", async () => {
    const diff = renderDiff("a\nb", "a\nextra\nb");
    expect(diff).toContain("  + extra");
  });
});

describe("expectGolden", () => {
  it("throws a message a reader can act on when output changed", async () => {
    const dir = scratch();
    compareToBaseline("thrown", result({ v: 1 }), updating(dir));

    expect(() => expectGolden("thrown", result({ v: 2 }), reading(dir))).toThrow(
      /changed[\s\S]*pnpm test:golden:update[\s\S]*line\(s\) differ/,
    );
  });

  it("throws for a missing baseline rather than passing quietly", async () => {
    expect(() => expectGolden("absent", result({ v: 1 }), reading(scratch()))).toThrow(
      /No baseline/,
    );
  });

  it("returns quietly when the output matches", async () => {
    const dir = scratch();
    compareToBaseline("ok", result({ v: 1 }), updating(dir));
    expect(expectGolden("ok", result({ v: 1 }), reading(dir)).status).toBe("matched");
  });

  it("surfaces a baseline that was edited by hand", async () => {
    // Someone "fixing" a failing golden test by editing the baseline directly
    // is the same silent drift the update flow exists to prevent — it just
    // has to fail on the next honest run.
    const dir = scratch();
    compareToBaseline("tampered", result({ v: 1 }), updating(dir));
    writeFileSync(join(dir, "tampered.golden.txt"), "hand-edited nonsense\n", "utf8");

    expect(() => expectGolden("tampered", result({ v: 1 }), reading(dir))).toThrow(/changed/);
  });
});
