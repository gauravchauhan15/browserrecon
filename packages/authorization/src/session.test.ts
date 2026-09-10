import { describe, expect, it } from "vitest";
import { buildSessionAuthorization } from "./session.js";
import type { ElevatedRisk } from "@browserrecon/policy";

const at = () => new Date("2026-09-10T12:34:56Z");

const RISKS: readonly ElevatedRisk[] = [
  {
    setting: "allowedMethods: POST",
    consequence: "The scan may change data on the target.",
  },
  {
    setting: "agent.stateChangingActions: true",
    consequence: "An explorer may deliberately complete state-changing workflows.",
  },
];

describe("buildSessionAuthorization", () => {
  it("records method, timestamp and target for session.json", () => {
    // BR-M0-07 acceptance criterion: the assertion travels with the artifact,
    // not just with the machine that produced it.
    expect(
      buildSessionAuthorization({
        method: "interactive",
        targetOrigin: "https://shop.example.com",
        risks: [],
        now: at,
      }),
    ).toEqual({
      acknowledged: true,
      method: "interactive",
      at: "2026-09-10T12:34:56.000Z",
      targetOrigin: "https://shop.example.com",
      acceptedRisks: [],
    });
  });

  it("lists accepted risks by setting name", () => {
    const record = buildSessionAuthorization({
      method: "flag",
      targetOrigin: "https://shop.example.com",
      risks: RISKS,
      now: at,
    });

    expect(record.acceptedRisks).toEqual([
      "allowedMethods: POST",
      "agent.stateChangingActions: true",
    ]);
  });

  it("does not copy consequence prose into the artifact", () => {
    // The consequence text is guidance for a human at a prompt, not a fact
    // about the scan. Recording it would put a paragraph of warning copy in
    // every exported session for no evidentiary gain.
    const record = buildSessionAuthorization({
      method: "flag",
      targetOrigin: "https://shop.example.com",
      risks: RISKS,
      now: at,
    });

    expect(JSON.stringify(record)).not.toContain("may change data");
  });

  it("carries only this run's target, not the operator's history", () => {
    // A stored record accumulates every target a user has confirmed. Copying
    // that into an exported artifact would leak an operator's whole target
    // list to whoever receives the scan.
    const record = buildSessionAuthorization({
      method: "config",
      targetOrigin: "https://shop.example.com",
      risks: [],
      now: at,
    });

    expect(Object.keys(record).sort()).toEqual([
      "acceptedRisks",
      "acknowledged",
      "at",
      "method",
      "targetOrigin",
    ]);
    expect(JSON.stringify(record)).not.toContain("confirmedTargets");
  });

  it("serializes cleanly for the session file", () => {
    const record = buildSessionAuthorization({
      method: "interactive",
      targetOrigin: "https://shop.example.com",
      risks: RISKS,
      now: at,
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});
