/**
 * @browserrecon/collector-console — console messages, capped.
 *
 * Build plan §13.1, §37.2; dev plan BR-M1-10.
 *
 * ## The cap is the point
 *
 * A page in a render loop can emit tens of thousands of console messages a
 * second, and an event store that takes all of them fills a disk during a
 * scan nobody is watching. So there is a hard cap, and — because §41's rule
 * is that a limit must be visible — the count of what was dropped is kept and
 * reported rather than the overflow being silently discarded.
 *
 * ## Redaction-aware
 *
 * Console output is where applications print tokens. §37.2 keeps the event
 * store raw and local, so nothing is stripped here; what this does is mark
 * messages so the export boundary knows to run them through the redactor
 * (BR-M1-25) rather than treating them as safe prose.
 */
import type { EventBus, EventEnvelope, Unsubscribe } from "@browserrecon/events";

export const PACKAGE_NAME = "@browserrecon/collector-console" as const;

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug" | "other";

export interface ConsoleMessage {
  readonly sequence: number;
  readonly level: ConsoleLevel;
  readonly text: string;
  readonly url?: string | undefined;
  readonly lineNumber?: number | undefined;
  /** Innermost-first call frames, where Chrome supplied a stack. */
  readonly stack?: readonly string[] | undefined;
  readonly targetId?: string | undefined;
}

export interface ConsoleModel {
  readonly messages: readonly ConsoleMessage[];
  readonly byLevel: ReadonlyMap<ConsoleLevel, number>;
  /**
   * Messages seen after the cap was reached.
   *
   * Non-zero means the log is a sample, not a record — which a reader has to
   * know before drawing any conclusion from what is there.
   */
  readonly dropped: number;
  readonly cappedAt: number;
}

export interface ConsoleCollector {
  readonly model: ConsoleModel;
  stop(): void;
}

/** Enough to diagnose a page; far short of filling a disk. */
export const DEFAULT_MESSAGE_CAP = 5_000;

/** Longest single message kept. A stack trace dumped as text can be enormous. */
export const DEFAULT_MESSAGE_BYTES = 8 * 1024;

interface ConsolePayload {
  readonly level?: string;
  readonly text?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly stack?: readonly string[];
  readonly targetId?: string;
}

const LEVELS = new Set<ConsoleLevel>(["log", "info", "warn", "error", "debug"]);

function levelOf(raw: string | undefined): ConsoleLevel {
  if (raw === undefined) return "other";
  const lower = raw.toLowerCase();
  // Chrome spells a few of these differently from the console API.
  if (lower === "warning") return "warn";
  if (lower === "verbose") return "debug";
  return LEVELS.has(lower as ConsoleLevel) ? (lower as ConsoleLevel) : "other";
}

export interface ConsoleOptions {
  readonly cap?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export function collectConsole(bus: EventBus, options: ConsoleOptions = {}): ConsoleCollector {
  const cap = options.cap ?? DEFAULT_MESSAGE_CAP;
  const maxBytes = options.maxBytes ?? DEFAULT_MESSAGE_BYTES;
  const messages: ConsoleMessage[] = [];
  let dropped = 0;
  let stopped = false;

  const unsubscribe: Unsubscribe = bus.subscribe(
    (envelope: EventEnvelope) => {
      if (envelope.type !== "console_message") return;
      if (messages.length >= cap) {
        // Counted, not ignored. The difference between "the page logged
        // nothing else" and "we stopped listening" is the whole value here.
        dropped += 1;
        return;
      }

      const payload = envelope.payload as ConsolePayload;
      const text = payload.text ?? "";
      messages.push({
        sequence: envelope.sequence,
        level: levelOf(payload.level),
        text: text.length > maxBytes ? `${text.slice(0, maxBytes)}…[truncated]` : text,
        ...(payload.url === undefined ? {} : { url: payload.url }),
        ...(payload.lineNumber === undefined ? {} : { lineNumber: payload.lineNumber }),
        ...(payload.stack === undefined ? {} : { stack: payload.stack }),
        ...(payload.targetId === undefined ? {} : { targetId: payload.targetId }),
      });
    },
    { name: "console-collector" },
  );

  return {
    get model(): ConsoleModel {
      const byLevel = new Map<ConsoleLevel, number>();
      for (const message of messages) {
        byLevel.set(message.level, (byLevel.get(message.level) ?? 0) + 1);
      }
      return { messages: [...messages], byLevel, dropped, cappedAt: cap };
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}
