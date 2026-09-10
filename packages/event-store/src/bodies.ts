/**
 * Content-addressed body store — build plan §22.2 (growth control).
 *
 * A single API response can be megabytes. Inlining those into the event log
 * would make it unreadable, unstreamable, and enormous — §22.2 requires
 * oversized bodies written out and referenced by hash instead.
 *
 * Addressing by content hash rather than by event id gets deduplication for
 * free, which matters more than it sounds: a shared vendor bundle referenced
 * by forty pages, or an identical API response observed on every visit, is
 * stored once. That is the same principle §10B.5 applies to JavaScript assets.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Replaces an oversized payload in the event log. */
export interface ExternalBodyRef {
  /** Marker, so a reader can tell a reference from a real payload. */
  readonly $external: true;
  /** `sha256:<hex>`, which is also the filename. */
  readonly hash: string;
  readonly bytes: number;
  /** How to interpret the stored file. */
  readonly encoding: "json";
}

/** Whether a payload is an externalized reference rather than the real thing. */
export function isExternalBodyRef(value: unknown): value is ExternalBodyRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $external?: unknown }).$external === true &&
    typeof (value as { hash?: unknown }).hash === "string"
  );
}

function filenameFor(hash: string): string {
  // `sha256:abc…` → `sha256-abc….json`, since ":" is awkward on Windows.
  return `${hash.replace(":", "-")}.json`;
}

export class BodyStore {
  readonly #dir: string;
  #written = 0;
  #deduplicated = 0;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get stats(): { written: number; deduplicated: number } {
    return { written: this.#written, deduplicated: this.#deduplicated };
  }

  /**
   * Store a payload and return its reference.
   *
   * Synchronous, because it is called from the synchronous append path: an
   * event is not considered recorded until its body is on disk too, and an
   * async write here would let the log reference a body that does not exist
   * yet if the process died in between.
   */
  put(payload: unknown): ExternalBodyRef {
    const serialized = JSON.stringify(payload) ?? "null";
    const digest = createHash("sha256").update(serialized).digest("hex");
    const hash = `sha256:${digest}`;
    const path = join(this.#dir, filenameFor(hash));

    if (existsSync(path)) {
      this.#deduplicated++;
    } else {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      writeFileSync(path, serialized, { mode: 0o600 });
      this.#written++;
    }

    return {
      $external: true,
      hash,
      bytes: Buffer.byteLength(serialized),
      encoding: "json",
    };
  }

  /**
   * Resolve a reference back to its payload.
   *
   * Async, unlike `put`: reading happens during export and correlation, where
   * nothing is racing a crash.
   */
  async get(ref: ExternalBodyRef): Promise<unknown> {
    const raw = await readFile(join(this.#dir, filenameFor(ref.hash)), "utf8");
    return JSON.parse(raw);
  }

  /** Whether a reference's body is present. Used by integrity checks. */
  has(ref: ExternalBodyRef): boolean {
    return existsSync(join(this.#dir, filenameFor(ref.hash)));
  }
}
