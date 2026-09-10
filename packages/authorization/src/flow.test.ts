/**
 * End-to-end gate behaviour against a real record file.
 *
 * The unit tests cover the decision table; these cover the sequence a user
 * actually experiences, because the failure that matters is not a wrong
 * branch — it is a scan starting when it should not have, or a pipeline
 * hanging when it should have failed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGate } from "./gate.js";
import { createRecord, readRecord, withConfirmedTarget, writeRecord } from "./record.js";
import { buildSessionAuthorization } from "./session.js";
import { defaultTargetPolicy, elevatedRisks, resolveTargetPolicy } from "@browserrecon/policy";

const TARGET = "https://shop.example.com";
const store = (): string => join(mkdtempSync(join(tmpdir(), "br-flow-")), "authorization.json");

/** The policy a bare `scan <url>` produces, and its risks. */
function risksFor(config: Record<string, unknown> = {}) {
  const result =
    Object.keys(config).length === 0
      ? defaultTargetPolicy(TARGET)
      : resolveTargetPolicy({ targetOrigin: TARGET, config });
  if (!result.ok) throw new Error("bad policy");
  return elevatedRisks(result.policy);
}

describe("a fresh machine", () => {
  it("prompts, then proceeds and persists once confirmed", () => {
    const path = store();

    // First run: nothing stored, terminal present.
    const first = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: false,
      interactive: true,
      risks: risksFor(),
    });
    expect(first.kind).toBe("prompt");

    // User answers yes; the caller persists.
    writeRecord(path, createRecord("interactive", TARGET));

    // Second run on the same target is silent.
    const second = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: false,
      interactive: true,
      risks: risksFor(),
    });
    expect(second.kind).toBe("allowed");
    if (second.kind !== "allowed") return;
    expect(second.recordNeedsUpdate).toBe(false);
  });

  it("refuses in a pipeline until the flag is passed", () => {
    const path = store();

    const withoutFlag = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: false,
      interactive: false,
      risks: risksFor(),
    });
    expect(withoutFlag.kind).toBe("denied");

    const withFlag = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: true,
      interactive: false,
      risks: risksFor(),
    });
    expect(withFlag.kind).toBe("allowed");
  });
});

describe("the default policy needs no risk acknowledgment", () => {
  it("produces no risk text at all", () => {
    // Ties the gate to the policy defaults: a read-only scan of one origin is
    // the common case, and it must not train users to click through warnings.
    const path = store();
    writeRecord(path, createRecord("interactive", TARGET));

    const outcome = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: false,
      interactive: true,
      risks: risksFor(),
    });

    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;
    expect(outcome.notice).toBe("");
  });
});

describe("enabling a destructive setting on an already-trusted target", () => {
  const dangerous = { policy: { allowedMethods: ["GET", "DELETE"] } };

  it("re-prompts even though the target was confirmed before", () => {
    const path = store();
    writeRecord(path, createRecord("interactive", TARGET));

    const outcome = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: false,
      interactive: true,
      risks: risksFor(dangerous),
    });

    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.notice).toMatch(/permanently delete/i);
  });

  it("refuses in a pipeline without the flag", () => {
    const path = store();
    writeRecord(path, createRecord("flag", TARGET));

    const outcome = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: false,
      interactive: false,
      risks: risksFor(dangerous),
    });

    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.reason).toBe("risks_not_accepted_non_interactive");
  });
});

describe("a corrupt store", () => {
  it("falls back to prompting rather than assuming consent", () => {
    // Fail-closed. Truncated or hand-edited state must not read as authority.
    const path = store();
    writeRecord(path, createRecord("interactive", TARGET));
    writeRecord(path, { version: 1 } as never);

    const outcome = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: false,
      interactive: true,
      risks: risksFor(),
    });
    expect(outcome.kind).toBe("prompt");
  });
});

describe("what reaches session.json", () => {
  it("captures the assertion for this run", () => {
    const path = store();
    writeRecord(path, createRecord("flag", TARGET));

    const risks = risksFor({ policy: { allowedMethods: ["GET", "POST"] } });
    const outcome = evaluateGate({
      targetOrigin: TARGET,
      record: readRecord(path),
      flagProvided: true,
      interactive: false,
      risks,
    });

    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;

    const record = buildSessionAuthorization({
      method: outcome.method,
      targetOrigin: TARGET,
      risks,
    });

    expect(record.acknowledged).toBe(true);
    expect(record.method).toBe("flag");
    expect(record.targetOrigin).toBe(TARGET);
    expect(record.acceptedRisks).toContain("allowedMethods: POST");
  });
});

describe("adding a second target", () => {
  it("prompts for the new origin and remembers both afterwards", () => {
    const path = store();
    writeRecord(path, createRecord("interactive", TARGET));

    const other = "https://staging.example.com";
    const outcome = evaluateGate({
      targetOrigin: other,
      record: readRecord(path),
      flagProvided: false,
      interactive: true,
      risks: [],
    });
    expect(outcome.kind).toBe("prompt");

    const existing = readRecord(path);
    if (existing === undefined) throw new Error("expected a record");
    writeRecord(path, withConfirmedTarget(existing, other));

    expect(readRecord(path)?.confirmedTargets).toEqual([TARGET, other]);

    const again = evaluateGate({
      targetOrigin: other,
      record: readRecord(path),
      flagProvided: false,
      interactive: true,
      risks: [],
    });
    expect(again.kind).toBe("allowed");
  });
});
