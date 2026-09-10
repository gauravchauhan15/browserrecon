/**
 * The acknowledgment record — build plan §7.4.
 *
 * §7.4 exists because the plan said "authorized target" throughout while
 * enforcing nothing: authorization was documentation, not a step. This is the
 * durable half of the fix — what the user asserted, when, how, and about
 * which targets.
 *
 * Two properties it must have. It is stored **outside** the repository and
 * outside any scan output, so it is not committed and not shipped with
 * artifacts. And it is written to the session record too (§7.4 point 3), so an
 * exported scan carries evidence of the assertion it ran under, rather than
 * that evidence living only on the machine that produced it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

/** How the user asserted authorization. */
export const ACKNOWLEDGMENT_METHODS = ["interactive", "flag", "config"] as const;
export type AcknowledgmentMethod = (typeof ACKNOWLEDGMENT_METHODS)[number];

/** Persisted between runs. */
export interface AuthorizationRecord {
  /** Schema version, so a future change to this file is migratable. */
  readonly version: 1;
  /** When first-run acknowledgment was given. ISO 8601. */
  readonly acknowledgedAt: string;
  readonly acknowledgedVia: AcknowledgmentMethod;
  /**
   * Origins the user has already confirmed.
   *
   * Remembered deliberately: re-confirming your own staging server on every
   * run is friction with no benefit, because the risk this gate addresses is
   * scanning the *wrong* target — which the first confirmation catches.
   */
  readonly confirmedTargets: readonly string[];
}

/**
 * What goes into `session.json` (§7.4 point 3).
 *
 * Deliberately narrower than the stored record: a scan artifact should carry
 * the assertion for *this* run, not the user's history of every other target
 * they have ever confirmed.
 */
export interface SessionAuthorization {
  readonly acknowledged: true;
  readonly method: AcknowledgmentMethod;
  readonly at: string;
  readonly targetOrigin: string;
  /** Higher-risk settings the user was shown and accepted (§7.4 point 4). */
  readonly acceptedRisks: readonly string[];
}

/**
 * Where the record lives.
 *
 * Follows the platform convention rather than dropping a dotfile in `$HOME`,
 * and respects `XDG_CONFIG_HOME` where set so a user who relocates their
 * config is not surprised.
 */
export function defaultRecordPath(
  env: Readonly<Record<string, string | undefined>> = {},
  home: string = homedir(),
  os: string = platform(),
): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") return join(xdg, "browserrecon", "authorization.json");
  if (os === "darwin") {
    return join(home, "Library", "Application Support", "browserrecon", "authorization.json");
  }
  if (os === "win32") {
    const appData = env.APPDATA;
    if (appData !== undefined && appData !== "") {
      return join(appData, "browserrecon", "authorization.json");
    }
  }
  return join(home, ".config", "browserrecon", "authorization.json");
}

/**
 * Read the record.
 *
 * A missing, unreadable or malformed file all return `undefined` — meaning
 * "not acknowledged", which fails closed into requiring acknowledgment. A
 * corrupt file must never be interpreted as consent.
 */
export function readRecord(path: string): AuthorizationRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;

  if (candidate.version !== 1) return undefined;
  if (typeof candidate.acknowledgedAt !== "string") return undefined;
  if (!(ACKNOWLEDGMENT_METHODS as readonly unknown[]).includes(candidate.acknowledgedVia)) {
    return undefined;
  }

  const targets = Array.isArray(candidate.confirmedTargets)
    ? candidate.confirmedTargets.filter((t): t is string => typeof t === "string")
    : [];

  return {
    version: 1,
    acknowledgedAt: candidate.acknowledgedAt,
    acknowledgedVia: candidate.acknowledgedVia as AcknowledgmentMethod,
    confirmedTargets: targets,
  };
}

/** Write the record, creating its directory if needed. */
export function writeRecord(path: string, record: AuthorizationRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Add a confirmed origin, leaving the original untouched. */
export function withConfirmedTarget(
  record: AuthorizationRecord,
  targetOrigin: string,
): AuthorizationRecord {
  if (record.confirmedTargets.includes(targetOrigin)) return record;
  return { ...record, confirmedTargets: [...record.confirmedTargets, targetOrigin] };
}

/** A fresh record for a first-run acknowledgment. */
export function createRecord(
  method: AcknowledgmentMethod,
  targetOrigin: string,
  now: () => Date = () => new Date(),
): AuthorizationRecord {
  return {
    version: 1,
    acknowledgedAt: now().toISOString(),
    acknowledgedVia: method,
    confirmedTargets: [targetOrigin],
  };
}
