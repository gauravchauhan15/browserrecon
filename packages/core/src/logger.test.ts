import { describe, expect, it } from "vitest";
import { createLogger, silentLogger, type LogRecord } from "./logger.js";
import { REDACTED, createRedactor } from "./redaction.js";

function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const records: LogRecord[] = [];
  const formatted: string[] = [];
  const logger = createLogger({
    now: () => new Date("2026-09-11T09:00:00Z"),
    ...options,
    sink: (record, text) => {
      records.push(record);
      formatted.push(text);
    },
  });
  return { logger, records, formatted, all: () => formatted.join("\n") };
}

describe("levels", () => {
  it("defaults to info, which stays quiet enough for CI", () => {
    const { logger, records } = capture();
    logger.debug("noisy internal detail");
    logger.info("scan started");
    expect(records.map((r) => r.level)).toEqual(["info"]);
  });

  it("filters by severity", () => {
    const { logger, records } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("emits nothing at silent", () => {
    const { logger, records } = capture({ level: "silent" });
    logger.error("even errors");
    expect(records).toHaveLength(0);
  });

  it("emits everything at debug", () => {
    const { logger, records } = capture({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records).toHaveLength(4);
  });

  it("reports whether a level is enabled, so callers can skip expensive fields", () => {
    const { logger } = capture({ level: "info" });
    expect(logger.isEnabled("info")).toBe(true);
    expect(logger.isEnabled("debug")).toBe(false);
  });

  it("silentLogger emits nothing at all", () => {
    expect(() => silentLogger().error("x")).not.toThrow();
    expect(silentLogger().isEnabled("error")).toBe(false);
  });
});

describe("redaction", () => {
  it("never emits a value under a sensitive key", () => {
    // BR-M0-10 acceptance criterion. Logs reach terminals, CI output and
    // GitHub issues, so this is the boundary that matters most.
    const { logger, all } = capture();
    logger.info("authenticating", {
      username: "admin",
      password: "hunter2",
      authorization: "Bearer abcdefghijklmnop",
      cookie: "session=xyz",
    });

    const text = all();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("session=xyz");
    expect(text).toContain("admin");
    expect(text).toContain(REDACTED);
  });

  it("redacts the message too, not just the fields", () => {
    // A caller interpolating a URL into the message would otherwise smuggle
    // credentials straight past the field-level rules.
    const { logger, all } = capture();
    logger.info("fetching https://admin:hunter2@shop.example.com/api");
    expect(all()).not.toContain("hunter2");
  });

  it("redacts secrets nested inside field objects", () => {
    const { logger, all } = capture();
    logger.warn("request failed", {
      request: { url: "/api/login", headers: { authorization: "Bearer secret-value-here" } },
    });
    expect(all()).not.toContain("secret-value-here");
    expect(all()).toContain("/api/login");
  });

  it("redacts a secret-shaped value under an innocuous key", () => {
    const { logger, all } = capture();
    logger.info("found in bundle", { note: "key is ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(all()).not.toContain("ghp_abcdefghij");
  });

  it("truncates a large blob rather than printing it", () => {
    const { logger, all } = capture();
    logger.debug("body", { body: "x".repeat(10_000) });
    expect(all().length).toBeLessThan(2000);
  });

  it("accepts a configured redactor", () => {
    const { logger, all } = capture({
      redactor: createRedactor({ keyPatterns: [/customer_ref/i] }),
    });
    logger.info("order", { customer_ref: "CUST-1" });
    expect(all()).not.toContain("CUST-1");
  });
});

describe("context correlation", () => {
  it("carries session context on every line", () => {
    // BR-M0-10 acceptance criterion: a log line has to be attributable to the
    // scan that produced it.
    const { logger, records } = capture({ context: { session_id: "sess_0001" } });
    logger.info("browser started");
    logger.warn("rate limited");
    expect(records.every((r) => r.fields.session_id === "sess_0001")).toBe(true);
  });

  it("merges child context with the parent's", () => {
    const { logger, records } = capture({ context: { session_id: "sess_0001" } });
    const pageLogger = logger.child({ page_id: "page_0007" });
    pageLogger.info("navigated");

    expect(records[0]?.fields).toMatchObject({
      session_id: "sess_0001",
      page_id: "page_0007",
    });
  });

  it("does not leak child context back to the parent", () => {
    const { logger, records } = capture();
    logger.child({ page_id: "page_0001" }).info("child line");
    logger.info("parent line");

    expect(records[0]?.fields.page_id).toBe("page_0001");
    expect(records[1]?.fields.page_id).toBeUndefined();
  });

  it("lets a call-site field override context", () => {
    const { logger, records } = capture({ context: { phase: "discovery" } });
    logger.info("switching", { phase: "browsing" });
    expect(records[0]?.fields.phase).toBe("browsing");
  });

  it("inherits level, redactor and sink into children", () => {
    const { logger, records } = capture({ level: "warn" });
    const child = logger.child({ page_id: "page_0001" });
    child.info("filtered out");
    child.warn("kept");
    expect(records.map((r) => r.message)).toEqual(["kept"]);
  });
});

describe("formats", () => {
  it("renders pretty output for a terminal", () => {
    const { logger, formatted } = capture({ format: "pretty" });
    logger.info("scan started", { pages: 34 });
    expect(formatted[0]).toContain("INFO");
    expect(formatted[0]).toContain("scan started");
    expect(formatted[0]).toContain("pages=34");
  });

  it("renders one JSON object per line for pipelines", () => {
    const { logger, formatted } = capture({
      format: "json",
      context: { session_id: "sess_0001" },
    });
    logger.warn("backing off", { status: 429 });

    const parsed = JSON.parse(formatted[0] ?? "{}");
    expect(parsed).toMatchObject({
      level: "warn",
      message: "backing off",
      time: "2026-09-11T09:00:00.000Z",
      session_id: "sess_0001",
      status: 429,
    });
  });
});

describe("resilience", () => {
  it("never throws when the sink fails", () => {
    // A broken reporting channel must not take down a scan that is otherwise
    // collecting good data — and there is nowhere useful to report it, since
    // the reporting channel is what just broke.
    const logger = createLogger({
      sink: () => {
        throw new Error("stdout closed");
      },
    });
    expect(() => logger.info("still fine")).not.toThrow();
  });

  it("never throws on an unserializable field", () => {
    const { logger } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logger.info("cyclic", { cyclic })).not.toThrow();
  });

  it("logs an Error without leaking its message contents", () => {
    const { logger, all } = capture();
    logger.error("scan failed", {
      error: new Error("could not authenticate with Bearer sk_live_abcdefghijklmnop1234"),
    });
    expect(all()).not.toContain("sk_live_abcdefghij");
    expect(all()).toContain("could not authenticate");
  });
});

describe("timestamps", () => {
  it("uses the injected clock so output is deterministic in tests", () => {
    const { logger, records } = capture();
    logger.info("x");
    expect(records[0]?.time).toBe("2026-09-11T09:00:00.000Z");
  });
});
