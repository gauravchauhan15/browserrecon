import { describe, expect, it } from "vitest";
import { evaluateGate, isAffirmative, type GateRequest } from "./gate.js";
import { createRecord } from "./record.js";
import type { ElevatedRisk } from "@browserrecon/policy";

const TARGET = "https://shop.example.com";

const RISK: ElevatedRisk = {
  setting: "allowedMethods: DELETE",
  consequence: "The scan may permanently delete data on the target.",
};

function request(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    targetOrigin: TARGET,
    record: undefined,
    flagProvided: false,
    interactive: true,
    risks: [],
    ...overrides,
  };
}

const acknowledged = (targets: string[] = [TARGET]) => ({
  ...createRecord("interactive", targets[0] ?? TARGET),
  confirmedTargets: targets,
});

describe("first run", () => {
  it("cannot start a scan without acknowledgment", () => {
    // BR-M0-07 acceptance criterion. A fresh install must not scan.
    const outcome = evaluateGate(request());
    expect(outcome.kind).toBe("prompt");
  });

  it("shows the authorized-use notice and the target before asking", () => {
    const outcome = evaluateGate(request());
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.notice).toContain("Only scan systems you own");
    expect(outcome.notice).toContain(TARGET);
    expect(outcome.question).toContain("[y/N]");
  });

  it("denies rather than hangs when there is no terminal", () => {
    // A gate that deadlocks CI is a gate people rip out. This is the single
    // most important behaviour in this file.
    const outcome = evaluateGate(request({ interactive: false }));
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.reason).toBe("not_acknowledged_non_interactive");
    expect(outcome.message).toContain("--i-am-authorized");
  });
});

describe("the --i-am-authorized flag", () => {
  it("works with no terminal and no stored record", () => {
    // The documented CI path.
    const outcome = evaluateGate(
      request({ interactive: false, flagProvided: true, record: undefined }),
    );
    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;
    expect(outcome.method).toBe("flag");
    expect(outcome.recordNeedsUpdate).toBe(true);
  });

  it("still prints elevated risks rather than swallowing them", () => {
    // The flag asserts authorization; it does not make a destructive setting
    // invisible in the log.
    const outcome = evaluateGate(request({ flagProvided: true, risks: [RISK] }));
    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;
    expect(outcome.notice).toContain("permanently delete data");
  });

  it("does not need a record update for an already-confirmed target", () => {
    const outcome = evaluateGate(request({ flagProvided: true, record: acknowledged() }));
    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;
    expect(outcome.recordNeedsUpdate).toBe(false);
  });
});

describe("a new target", () => {
  it("asks again, even on an acknowledged machine", () => {
    // The risk this addresses is scanning the *wrong* target, so a new origin
    // is exactly when confirmation is worth asking for.
    const outcome = evaluateGate(
      request({
        targetOrigin: "https://someone-elses-site.example.com",
        record: acknowledged(),
      }),
    );
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.notice).toContain("someone-elses-site.example.com");
    // The full first-run notice is not repeated; they have seen it.
    expect(outcome.notice).not.toContain("Only scan systems you own");
  });

  it("denies with guidance when non-interactive", () => {
    const outcome = evaluateGate(
      request({
        targetOrigin: "https://new.example.com",
        record: acknowledged(),
        interactive: false,
      }),
    );
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.reason).toBe("target_not_confirmed_non_interactive");
  });
});

describe("an already-confirmed target", () => {
  it("proceeds without asking", () => {
    // Re-confirming your own staging server every run is friction with no
    // benefit.
    const outcome = evaluateGate(request({ record: acknowledged() }));
    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;
    expect(outcome.method).toBe("config");
    expect(outcome.recordNeedsUpdate).toBe(false);
    expect(outcome.notice).toBe("");
  });

  it("proceeds silently with no terminal", () => {
    const outcome = evaluateGate(request({ record: acknowledged(), interactive: false }));
    expect(outcome.kind).toBe("allowed");
  });
});

describe("elevated risks", () => {
  it("re-asks on a confirmed target when a risky setting is enabled", () => {
    // Consent is per-run for these. "I once agreed DELETE was fine" must not
    // carry silently into a different scan a month later.
    const outcome = evaluateGate(request({ record: acknowledged(), risks: [RISK] }));
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.notice).toContain("permanently delete data");
  });

  it("denies non-interactively without the flag, even on a confirmed target", () => {
    const outcome = evaluateGate(
      request({ record: acknowledged(), interactive: false, risks: [RISK] }),
    );
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.reason).toBe("risks_not_accepted_non_interactive");
    expect(outcome.message).toContain("permanently delete data");
  });

  it("stays quiet when there is nothing risky to report", () => {
    // Avoids training users to dismiss a warning that always appears.
    const outcome = evaluateGate(request({ record: acknowledged() }));
    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;
    expect(outcome.notice).toBe("");
  });

  it("describes consequences in plain language, not setting names", () => {
    // §7.4 point 4. A jargon label is not a warning.
    const outcome = evaluateGate(request({ flagProvided: true, risks: [RISK] }));
    expect(outcome.kind).toBe("allowed");
    if (outcome.kind !== "allowed") return;
    expect(outcome.notice).toMatch(/may permanently delete/i);
    expect(outcome.notice).toContain("Only continue on a target you control");
  });
});

describe("isAffirmative", () => {
  it("accepts only an explicit yes", () => {
    for (const yes of ["y", "Y", "yes", "YES", " yes "]) {
      expect(isAffirmative(yes), yes).toBe(true);
    }
  });

  it("treats empty input as a refusal", () => {
    // The prompt reads [y/N], so pressing Enter to get past it must not be
    // taken as agreement.
    expect(isAffirmative("")).toBe(false);
    expect(isAffirmative("   ")).toBe(false);
  });

  it("rejects everything ambiguous", () => {
    for (const no of ["n", "no", "sure", "ok", "1", "true", "yep", "yeah"]) {
      expect(isAffirmative(no), no).toBe(false);
    }
  });
});
