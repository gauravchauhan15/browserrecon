/**
 * @browserrecon/collector-storage — cookies and storage, metadata first.
 *
 * Build plan §13.1, §37.2; dev plan BR-M1-11.
 *
 * ## Values are off by default, and that is a security decision
 *
 * A cookie jar mid-scan holds session tokens. §37.2 keeps the event store raw
 * and local precisely so evidence is not lost — but "we could keep it" is not
 * "we should keep it by default". The *metadata* answers almost every
 * question a recon tool has: which cookies exist, how they are scoped, and
 * whether they are protected. The values answer one more question and carry
 * every risk.
 *
 * So values require `captureValues: true` and are marked for redaction at the
 * export boundary (BR-M1-25) even then. The default produces a complete
 * picture of the attack surface with nothing worth stealing in it.
 *
 * ## Security attributes are the finding
 *
 * `HttpOnly`, `Secure`, `SameSite` and `Partitioned` are why this collector
 * exists at all. A session cookie without `HttpOnly` is reachable from any XSS;
 * without `Secure` it crosses plaintext; `SameSite=None` opens it to
 * cross-site requests. Recording the flags is recording the finding.
 */
import type { EventBus, EventEnvelope, Unsubscribe } from "@browserrecon/events";

export const PACKAGE_NAME = "@browserrecon/collector-storage" as const;

export type SameSite = "Strict" | "Lax" | "None" | "unspecified";

export interface CookieRecord {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
  /** Length in bytes. Present even when the value is not. */
  readonly size: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: SameSite;
  readonly session: boolean;
  readonly partitioned?: boolean | undefined;
  /** Only when `captureValues` was set. Redact before export (§37.2). */
  readonly value?: string | undefined;
}

export type StorageArea = "local" | "session";

export interface StorageRecord {
  readonly area: StorageArea;
  readonly origin: string;
  readonly key: string;
  readonly size: number;
  readonly value?: string | undefined;
}

/** A cookie whose flags leave it exposed, and why. */
export interface CookieWeakness {
  readonly cookie: string;
  readonly issue: "no_httponly" | "no_secure" | "samesite_none" | "samesite_unspecified";
  readonly detail: string;
}

export interface StorageModel {
  readonly cookies: readonly CookieRecord[];
  readonly storage: readonly StorageRecord[];
  /** Cookies whose flags are worth a reader's attention. */
  readonly weaknesses: readonly CookieWeakness[];
  readonly valuesCaptured: boolean;
}

export interface StorageCollector {
  readonly model: StorageModel;
  stop(): void;
}

/** Names that usually carry a session, where a missing flag matters most. */
const SESSION_NAME = /sess|sid|auth|token|jwt|login|remember/i;

/**
 * Flags worth reporting on.
 *
 * Deliberately conservative about `no_httponly`: almost every analytics cookie
 * lacks it and reporting all of them buries the one that matters, so only
 * cookies whose name suggests a session are flagged for it. The other three
 * apply to every cookie, because they are properties of how it travels rather
 * than of what it holds.
 */
export function findWeaknesses(cookies: readonly CookieRecord[]): CookieWeakness[] {
  const out: CookieWeakness[] = [];
  for (const cookie of cookies) {
    const label = `${cookie.name} (${cookie.domain}${cookie.path})`;

    if (!cookie.httpOnly && SESSION_NAME.test(cookie.name)) {
      out.push({
        cookie: label,
        issue: "no_httponly",
        detail: "a session-shaped cookie readable from JavaScript is reachable from any XSS",
      });
    }
    if (!cookie.secure) {
      out.push({
        cookie: label,
        issue: "no_secure",
        detail: "sent over plaintext HTTP as well as HTTPS",
      });
    }
    if (cookie.sameSite === "None") {
      out.push({
        cookie: label,
        issue: "samesite_none",
        detail: "attached to cross-site requests; only safe if that is deliberate",
      });
    } else if (cookie.sameSite === "unspecified") {
      out.push({
        cookie: label,
        issue: "samesite_unspecified",
        detail: "no SameSite set, so the browser's default decides — and defaults differ",
      });
    }
  }
  return out;
}

interface CookiePayload {
  readonly cookies?: readonly Partial<CookieRecord>[];
}

interface StoragePayload {
  readonly area?: StorageArea;
  readonly origin?: string;
  readonly key?: string;
  readonly value?: string;
}

export interface StorageOptions {
  /**
   * Keep cookie and storage values.
   *
   * Off by default. See the note at the top: metadata answers almost every
   * question, and values carry every risk.
   */
  readonly captureValues?: boolean | undefined;
}

export function collectStorage(bus: EventBus, options: StorageOptions = {}): StorageCollector {
  const captureValues = options.captureValues === true;
  const cookies = new Map<string, CookieRecord>();
  const storage = new Map<string, StorageRecord>();
  let stopped = false;

  const unsubscribe: Unsubscribe = bus.subscribe(
    (envelope: EventEnvelope) => {
      if (envelope.type === "cookie_observation") {
        for (const raw of (envelope.payload as CookiePayload).cookies ?? []) {
          if (raw.name === undefined) continue;
          const value = raw.value ?? "";
          const record: CookieRecord = {
            name: raw.name,
            domain: raw.domain ?? "",
            path: raw.path ?? "/",
            // Recorded even when the value is not kept, because size alone
            // distinguishes a flag from a token.
            size: raw.size ?? Buffer.byteLength(value, "utf8"),
            httpOnly: raw.httpOnly === true,
            secure: raw.secure === true,
            sameSite: raw.sameSite ?? "unspecified",
            session: raw.session === true,
            ...(raw.partitioned === undefined ? {} : { partitioned: raw.partitioned }),
            ...(captureValues && raw.value !== undefined ? { value: raw.value } : {}),
          };
          // Keyed by identity, so re-reading the jar updates rather than
          // duplicates.
          cookies.set(`${record.domain}${record.path}:${record.name}`, record);
        }
        return;
      }

      if (envelope.type === "storage_observation") {
        const payload = envelope.payload as StoragePayload;
        if (payload.key === undefined) return;
        const value = payload.value ?? "";
        const record: StorageRecord = {
          area: payload.area ?? "local",
          origin: payload.origin ?? "",
          key: payload.key,
          size: Buffer.byteLength(value, "utf8"),
          ...(captureValues && payload.value !== undefined ? { value: payload.value } : {}),
        };
        storage.set(`${record.area}:${record.origin}:${record.key}`, record);
      }
    },
    { name: "storage-collector" },
  );

  return {
    get model(): StorageModel {
      const list = [...cookies.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      return {
        cookies: list,
        storage: [...storage.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
        weaknesses: findWeaknesses(list),
        valuesCaptured: captureValues,
      };
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}
