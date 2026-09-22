/**
 * TOTP — build plan §12.2; dev plan BR-M2-15. RFC 6238 over RFC 4226.
 *
 * ## What this is, and what it is not
 *
 * This generates the same six digits the user's own authenticator app would,
 * from a shared secret **the user supplied**, for a test account **the user
 * controls**. It is the tool holding a key it was handed.
 *
 * §12.2's table ends with `MFA bypass — Never — Not supported`. Nothing here
 * attempts a factor we do not have the key to: there is no code that guesses
 * a code, replays one, brute-forces a window, or tries to skip a step. The
 * distinction is not a matter of degree — holding a key someone gave you and
 * defeating a lock are different acts — and `tests/meta/no-solver.test.ts`
 * scans the repository to keep it that way.
 *
 * ## Implemented rather than depended on
 *
 * HMAC-SHA1 over an 8-byte counter, truncated. Node's `crypto` has
 * everything needed, and a dependency that handles secrets is a dependency
 * whose supply chain now handles secrets.
 */
import { createHmac } from "node:crypto";

export interface TotpOptions {
  /** Seconds per step. RFC 6238's default, and what every app uses. */
  readonly stepSeconds?: number | undefined;
  readonly digits?: number | undefined;
  /** `SHA1` unless the application says otherwise; SHA256 and SHA512 exist. */
  readonly algorithm?: "sha1" | "sha256" | "sha512" | undefined;
}

/** `Required<T>` keeps `| undefined` when the type spells it; this strips it. */
type Resolved<T> = { readonly [K in keyof T]-?: NonNullable<T[K]> };

export const DEFAULT_TOTP: Resolved<TotpOptions> = {
  stepSeconds: 30,
  digits: 6,
  algorithm: "sha1",
};

/**
 * Decode a base32 secret, as every authenticator QR code encodes one.
 *
 * Tolerant of the two things users actually do: lower case, and the spaces
 * that services insert every four characters for readability. Padding is
 * optional because most services omit it.
 *
 * Throws on a character that is not base32. A secret that silently decoded
 * to the wrong bytes would produce six plausible digits that are always
 * wrong, and the user would conclude their credentials are bad.
 */
export function decodeBase32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned === "") throw new Error("the TOTP secret is empty");

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of cleaned) {
    const index = alphabet.indexOf(character);
    if (index === -1) {
      // The character is named, the secret is not. An error message is a
      // place secrets leak into logs.
      throw new Error(`the TOTP secret contains "${character}", which is not base32`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }

  if (out.length === 0) throw new Error("the TOTP secret decoded to no bytes");
  return Buffer.from(out);
}

/** RFC 4226's HOTP, which TOTP is a counter over. */
export function hotp(secret: Buffer, counter: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? DEFAULT_TOTP.digits;
  const algorithm = options.algorithm ?? DEFAULT_TOTP.algorithm;

  // An 8-byte big-endian counter. Written as two 32-bit halves because a
  // JavaScript number cannot hold 64 bits exactly, and `writeBigUInt64BE`
  // would need the caller to have a BigInt.
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(algorithm, secret).update(buffer).digest();

  // RFC 4226 §5.3's dynamic truncation.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * The current code.
 *
 * `atMs` is a parameter rather than a call to `Date.now()`: §36.1 wants
 * determinism to be testable, and a function that reads a clock cannot be
 * tested against RFC 6238's published vectors.
 */
export function totp(secret: string, atMs: number, options: TotpOptions = {}): string {
  const step = options.stepSeconds ?? DEFAULT_TOTP.stepSeconds;
  const counter = Math.floor(atMs / 1000 / step);
  return hotp(decodeBase32(secret), counter, options);
}

/**
 * Seconds until this code stops being valid.
 *
 * Used to avoid submitting a code with half a second left on it — the login
 * would fail for a reason that looks like wrong credentials, and a user
 * debugging that finds nothing wrong with their credentials.
 */
export function secondsRemaining(atMs: number, options: TotpOptions = {}): number {
  const step = options.stepSeconds ?? DEFAULT_TOTP.stepSeconds;
  return step - (Math.floor(atMs / 1000) % step);
}

/** Below this, wait for the next step rather than submitting a stale code. */
export const MIN_REMAINING_SECONDS = 3;

export function shouldWaitForNextCode(atMs: number, options: TotpOptions = {}): boolean {
  return secondsRemaining(atMs, options) < MIN_REMAINING_SECONDS;
}
