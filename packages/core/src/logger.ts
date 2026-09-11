/**
 * Diagnostic logging — build plan §33.
 *
 * ## Logs are not the event log
 *
 * Two record streams with opposite rules, and confusing them would be a real
 * mistake:
 *
 *   `events.jsonl` is **evidence**. Raw, unredacted, local-only, complete. It
 *   is what the scan observed, and correlation depends on it being untouched.
 *
 *   Diagnostics are about **the tool's own behaviour** — "Chrome started",
 *   "katana not found on PATH", "backing off after 429". They go to terminals,
 *   CI output, and issues people paste into GitHub, so they are redacted, and
 *   they are lossy by design: dropping a log line costs nothing, dropping an
 *   event costs the scan.
 *
 * ## No raw payload path
 *
 * There is deliberately no `log(envelope)` or `log(responseBody)`. Structured
 * fields are chosen explicitly at each call site and redacted on the way out.
 * That structural limit is the real protection; redaction is the safety net
 * under it, since pattern matching alone cannot promise a password is never
 * printed (see redaction.ts).
 *
 * Logging never throws. A broken sink must not take down a scan that is
 * otherwise collecting good data.
 */
import { createRedactor, type Redactor } from "./redaction.js";

/** Verbosity, ordered least to most. */
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** Structured fields attached to a line. */
export type LogFields = Readonly<Record<string, unknown>>;

/** A rendered log line, before it reaches a sink. */
export interface LogRecord {
  readonly level: Exclude<LogLevel, "silent">;
  readonly message: string;
  readonly time: string;
  readonly fields: LogFields;
}

/** Where lines go. Injected so tests need no stdout capture. */
export type LogSink = (record: LogRecord, formatted: string) => void;

export type LogFormat = "pretty" | "json";

export interface LoggerOptions {
  readonly level?: LogLevel | undefined;
  readonly format?: LogFormat | undefined;
  readonly sink?: LogSink | undefined;
  readonly redactor?: Redactor | undefined;
  /** Fields on every line from this logger — session id, page id, and so on. */
  readonly context?: LogFields | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** A logger carrying extra context, for scoping to a session or page. */
  child(context: LogFields): Logger;
  /** Whether a level would be emitted. Guards expensive field construction. */
  isEnabled(level: Exclude<LogLevel, "silent">): boolean;
  readonly level: LogLevel;
}

function formatPretty(record: LogRecord): string {
  const label = record.level.toUpperCase().padEnd(5);
  const fieldText = Object.entries(record.fields)
    .map(
      ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" ");
  return fieldText === ""
    ? `${label} ${record.message}`
    : `${label} ${record.message}  ${fieldText}`;
}

function formatJson(record: LogRecord): string {
  return JSON.stringify({
    level: record.level,
    time: record.time,
    message: record.message,
    ...record.fields,
  });
}

/** Default sink: warnings and errors to stderr, the rest to stdout. */
const consoleSink: LogSink = (record, formatted) => {
  if (record.level === "error" || record.level === "warn") {
    process.stderr.write(`${formatted}\n`);
  } else {
    process.stdout.write(`${formatted}\n`);
  }
};

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  readonly #format: LogFormat;
  readonly #sink: LogSink;
  readonly #redactor: Redactor;
  readonly #context: LogFields;
  readonly #now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.#format = options.format ?? "pretty";
    this.#sink = options.sink ?? consoleSink;
    this.#redactor = options.redactor ?? createRedactor();
    this.#context = options.context ?? {};
    this.#now = options.now ?? ((): Date => new Date());
  }

  isEnabled(level: Exclude<LogLevel, "silent">): boolean {
    return SEVERITY[level] <= SEVERITY[this.level];
  }

  error(message: string, fields?: LogFields): void {
    this.#emit("error", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#emit("warn", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#emit("info", message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.#emit("debug", message, fields);
  }

  child(context: LogFields): Logger {
    return new StructuredLogger({
      level: this.level,
      format: this.#format,
      sink: this.#sink,
      redactor: this.#redactor,
      context: { ...this.#context, ...context },
      now: this.#now,
    });
  }

  #emit(level: Exclude<LogLevel, "silent">, message: string, fields?: LogFields): void {
    if (!this.isEnabled(level)) return;

    try {
      // Both message and fields pass through redaction. The message is not
      // trusted either: a caller interpolating a URL into it would otherwise
      // smuggle credentials past the field-level rules.
      const merged = { ...this.#context, ...(fields ?? {}) };
      const record: LogRecord = {
        level,
        message: this.#redactor.redactString(message),
        time: this.#now().toISOString(),
        fields: this.#redactor.redact(merged) as LogFields,
      };

      this.#sink(record, this.#format === "json" ? formatJson(record) : formatPretty(record));
    } catch {
      // A logging failure must never take down a scan that is otherwise
      // collecting good data. There is nowhere useful to report this — the
      // reporting channel is what just broke.
    }
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

/** A logger that emits nothing. For tests and `--quiet`. */
export function silentLogger(): Logger {
  return new StructuredLogger({ level: "silent", sink: () => {} });
}
