import type { BarrierCategory } from "@browserrecon/collector-network";
import { describe, expect, it } from "vitest";
import {
  ASSIST_TIMEOUT_MS,
  HUMAN_CLEARABLE,
  decideAssist,
  runAssist,
  type AssistContext,
  type AssistPrompt,
} from "./index.js";

const headed: AssistContext = {
  category: "challenge_detected",
  headless: false,
  nonInteractive: false,
};

function prompt(answer: "cleared" | "skipped", onAsk?: () => void): AssistPrompt {
  return {
    ask: () => {
      onAsk?.();
      return Promise.resolve(answer);
    },
  };
}

const never: AssistPrompt = { ask: () => new Promise(() => {}) };

function clock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: () => void;
} {
  let current = 1_700_000_000_000;
  let release: (() => void) | undefined;
  return {
    now: () => current,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        release = () => {
          current += ms;
          resolve();
        };
      }),
    advance: () => release?.(),
  };
}

describe("headless never prompts", () => {
  it("records the barrier and continues", async () => {
    // A prompt in CI is a hang, and nobody sees a hung pipeline for an hour.
    let asked = false;
    const record = await runAssist({
      context: { ...headed, headless: true },
      url: "https://shop.example.com/login",
      prompt: prompt("cleared", () => {
        asked = true;
      }),
      now: () => 1_700_000_000_000,
      sleep: () => Promise.resolve(),
    });

    expect(asked, "a headless run asked a question nobody could answer").toBe(false);
    expect(record.outcome).toBe("not_offered");
  });

  it("checks headless before anything else", () => {
    // Ordering matters: no later condition may make a headless run prompt.
    for (const category of HUMAN_CLEARABLE) {
      const decision = decideAssist({ category, headless: true, nonInteractive: false });
      expect(decision.action, category).toBe("record");
    }
  });

  it("never prompts in CI even with a terminal attached", () => {
    // A terminal can exist and still have nobody watching it.
    expect(decideAssist({ ...headed, nonInteractive: true }).action).toBe("record");
  });

  it("respects an operator who said stop asking", () => {
    expect(decideAssist({ ...headed, assistDisabled: true }).action).toBe("record");
  });
});

describe("what a person is asked to clear", () => {
  it("offers only barriers a person could plausibly clear", () => {
    expect(decideAssist(headed).action).toBe("prompt");
    expect(decideAssist({ ...headed, category: "authentication_required" }).action).toBe(
      "prompt",
    );
  });

  it("does not ask an operator to override the target's refusal", () => {
    // §7.3, one human step removed. A `forbidden` is the target saying no,
    // and prompting someone to "handle" it is inviting circumvention.
    for (const category of [
      "forbidden",
      "robots_excluded",
      "scope_excluded",
      "rate_limited",
      "geo_restricted",
      "automation_signature_blocked",
    ] as BarrierCategory[]) {
      const decision = decideAssist({ ...headed, category });
      expect(decision.action, category).toBe("record");
    }
  });

  it("explains why it did not offer", () => {
    const decision = decideAssist({ ...headed, category: "forbidden" });
    expect(decision.reason).toContain("refusing");
  });
});

describe("the prompt", () => {
  it("records that a human cleared the barrier", async () => {
    // §10C.7: the report has to show a human intervened, at what point and
    // for which barrier — otherwise the coverage looks unassisted.
    const record = await runAssist({
      context: headed,
      url: "https://shop.example.com/challenge",
      prompt: prompt("cleared"),
      now: () => 1_700_000_000_000,
      sleep: () => new Promise(() => {}),
    });

    expect(record.outcome).toBe("cleared");
    expect(record.url).toBe("https://shop.example.com/challenge");
    expect(record.category).toBe("challenge_detected");
    expect(record.at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("records a skip as a barrier, not as coverage", async () => {
    const record = await runAssist({
      context: headed,
      url: "https://shop.example.com/challenge",
      prompt: prompt("skipped"),
      now: () => 1,
      sleep: () => new Promise(() => {}),
    });
    expect(record.outcome).toBe("skipped");
  });

  it("falls back to recording when nobody answers", async () => {
    // An operator who has not answered in two minutes has walked away, and
    // a finished scan with a recorded barrier beats one still at a prompt.
    const time = clock();
    const pending = runAssist({
      context: headed,
      url: "https://shop.example.com/challenge",
      prompt: never,
      timeoutMs: 1_000,
      now: time.now,
      sleep: time.sleep,
    });
    time.advance();

    const record = await pending;
    expect(record.outcome).toBe("timed_out");
    expect(record.waitedMs).toBe(1_000);
  });

  it("waits long enough for an MFA push but not long enough to look hung", () => {
    expect(ASSIST_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(ASSIST_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });

  it("always produces a record, whatever happened", async () => {
    // The scan's story has to be complete: every barrier reached leaves a
    // trace, including the ones nobody was offered.
    for (const context of [
      headed,
      { ...headed, headless: true },
      { ...headed, category: "forbidden" as BarrierCategory },
    ]) {
      const record = await runAssist({
        context,
        url: "https://shop.example.com/x",
        prompt: prompt("skipped"),
        now: () => 1,
        sleep: () => new Promise(() => {}),
      });
      expect(record.url).toBe("https://shop.example.com/x");
    }
  });
});
