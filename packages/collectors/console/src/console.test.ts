import { describe, expect, it } from "vitest";
import { EventBus } from "@browserrecon/events";
import { collectConsole } from "./index.js";

const say = async (bus: EventBus, payload: Record<string, unknown> = {}): Promise<void> => {
  await bus.publish({
    type: "console_message",
    provenance: "observed",
    auth_context: "anonymous",
    payload: { level: "log", text: "hello", ...payload },
  });
};

describe("the cap", () => {
  it("stops collecting and counts what it dropped", async () => {
    // A page in a render loop can emit tens of thousands a second. Dropping
    // silently would make the log look like a quiet page.
    const bus = new EventBus();
    const collector = collectConsole(bus, { cap: 10 });
    for (let i = 0; i < 25; i += 1) await say(bus, { text: `m${i}` });
    await bus.drain();

    expect(collector.model.messages).toHaveLength(10);
    expect(collector.model.dropped).toBe(15);
    expect(collector.model.cappedAt).toBe(10);
  });

  it("truncates one enormous message rather than refusing it", async () => {
    const bus = new EventBus();
    const collector = collectConsole(bus, { maxBytes: 20 });
    await say(bus, { text: "x".repeat(500) });
    await bus.drain();

    const text = collector.model.messages[0]?.text ?? "";
    expect(text.length).toBeLessThan(60);
    expect(text).toContain("truncated");
  });
});

describe("what is preserved", () => {
  it("keeps the level, normalising Chrome's spellings", async () => {
    const bus = new EventBus();
    const collector = collectConsole(bus);
    for (const level of ["log", "warning", "error", "verbose", "info", "wat"]) {
      await say(bus, { level });
    }
    await bus.drain();

    expect(collector.model.messages.map((m) => m.level)).toEqual([
      "log",
      "warn",
      "error",
      "debug",
      "info",
      "other",
    ]);
  });

  it("keeps the source location and stack where present", async () => {
    const bus = new EventBus();
    const collector = collectConsole(bus);
    await say(bus, {
      url: "https://app.test/app.js",
      lineNumber: 42,
      stack: ["f@app.js:42:1"],
    });
    await bus.drain();

    expect(collector.model.messages[0]).toMatchObject({
      url: "https://app.test/app.js",
      lineNumber: 42,
      stack: ["f@app.js:42:1"],
    });
  });

  it("counts by level", async () => {
    const bus = new EventBus();
    const collector = collectConsole(bus);
    await say(bus, { level: "error" });
    await say(bus, { level: "error" });
    await say(bus, { level: "log" });
    await bus.drain();

    expect(collector.model.byLevel.get("error")).toBe(2);
    expect(collector.model.byLevel.get("log")).toBe(1);
  });

  it("ignores other event types", async () => {
    const bus = new EventBus();
    const collector = collectConsole(bus);
    await bus.publish({
      type: "network_request",
      provenance: "observed",
      auth_context: "anonymous",
      payload: {},
    });
    await bus.drain();
    expect(collector.model.messages).toHaveLength(0);
  });
});
