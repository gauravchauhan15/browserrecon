/**
 * Event Store — build plan §22.1, §32.9.
 *
 * "The event store is the source of truth." Every other component can fail
 * and be restarted; what has been written here is what the scan actually
 * observed.
 *
 * ## What "durable" means here, precisely
 *
 * Two different failures, two different guarantees, because conflating them
 * either overstates the protection or makes the store far too slow:
 *
 *   **Process death** — Chrome crashes, the user hits Ctrl-C, the OOM killer
 *   arrives. Every append is a synchronous `writeSync` into the OS page cache
 *   before `append()` returns, so nothing already appended is lost. This is
 *   the failure that actually happens during a scan, and it is fully covered.
 *
 *   **Machine death** — power loss, kernel panic. Bytes in the page cache are
 *   gone. `fsync` is what survives that, and it costs milliseconds, so it runs
 *   at checkpoints rather than per event. Between checkpoints a machine death
 *   can lose recent events, and the checkpoint file records exactly how far
 *   the log is known-safe so `resume` (§30) never has to guess.
 *
 * Calling both cases "durable" without distinguishing them would be the same
 * class of overclaim as a guarantee the runtime cannot keep.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { EventEnvelope } from "@browserrecon/events";
import { BodyStore, type ExternalBodyRef } from "./bodies.js";
import { sessionPaths, type SessionPaths } from "./layout.js";

/** One segment of the event log. */
export interface SegmentRecord {
  readonly ordinal: number;
  readonly filename: string;
  /** Sequence of the first event written to this segment. */
  readonly firstSequence: number;
  /** Sequence of the last event written. Updated as the segment grows. */
  readonly lastSequence: number;
  readonly events: number;
  readonly bytes: number;
}

/** `segments.json` — how a reader knows the order and where to resume. */
export interface Manifest {
  readonly version: 1;
  readonly sessionId: string;
  readonly segments: readonly SegmentRecord[];
}

/** `checkpoint.json` — how far the log is known to be safely on disk. */
export interface Checkpoint {
  readonly version: 1;
  readonly sessionId: string;
  /** Highest sequence that has been fsynced. Safe across machine death. */
  readonly durableSequence: number;
  /** Highest sequence written at all. Safe across process death. */
  readonly writtenSequence: number;
  readonly at: string;
  readonly segments: number;
}

export interface EventStoreOptions {
  /** Session directory. Created if absent. */
  readonly dir: string;
  readonly sessionId: string;
  /** Rotate once a segment reaches this size. */
  readonly maxSegmentBytes?: number | undefined;
  /** Payloads whose serialized form exceeds this are externalized. */
  readonly maxInlinePayloadBytes?: number | undefined;
  /** fsync after this many appends. */
  readonly checkpointEveryEvents?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface EventStoreStats {
  readonly appended: number;
  readonly bytesWritten: number;
  readonly segments: number;
  readonly externalizedBodies: number;
  readonly deduplicatedBodies: number;
  readonly durableSequence: number;
  readonly writtenSequence: number;
}

/** 64 MiB keeps a segment comfortably streamable and greppable. */
const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
/** 64 KiB: big enough for normal API responses, small enough to keep lines readable. */
const DEFAULT_MAX_INLINE_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_CHECKPOINT_EVERY_EVENTS = 100;

export class EventStore {
  readonly paths: SessionPaths;
  readonly #sessionId: string;
  readonly #bodies: BodyStore;
  readonly #maxSegmentBytes: number;
  readonly #maxInlinePayloadBytes: number;
  readonly #checkpointEveryEvents: number;
  readonly #now: () => Date;

  #fd: number | undefined;
  #segments: SegmentRecord[] = [];
  #currentOrdinal = 0;
  #currentBytes = 0;
  #currentEvents = 0;
  #currentFirstSequence = 0;
  #currentLastSequence = 0;

  #appended = 0;
  #bytesWritten = 0;
  #sinceCheckpoint = 0;
  #durableSequence = 0;
  #writtenSequence = 0;
  #closed = false;

  constructor(options: EventStoreOptions) {
    this.paths = sessionPaths(options.dir);
    this.#sessionId = options.sessionId;
    this.#bodies = new BodyStore(this.paths.bodies);
    this.#maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.#maxInlinePayloadBytes =
      options.maxInlinePayloadBytes ?? DEFAULT_MAX_INLINE_PAYLOAD_BYTES;
    this.#checkpointEveryEvents =
      options.checkpointEveryEvents ?? DEFAULT_CHECKPOINT_EVERY_EVENTS;
    this.#now = options.now ?? ((): Date => new Date());

    // 0700: the directory holds unredacted captured data (§37.2).
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    this.#openSegment(1);
    this.#writeManifest();
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get stats(): EventStoreStats {
    const bodies = this.#bodies.stats;
    return {
      appended: this.#appended,
      bytesWritten: this.#bytesWritten,
      segments: this.#segments.length,
      externalizedBodies: bodies.written,
      deduplicatedBodies: bodies.deduplicated,
      durableSequence: this.#durableSequence,
      writtenSequence: this.#writtenSequence,
    };
  }

  /**
   * Append an event.
   *
   * Synchronous and returns only once the bytes are with the OS, so a caller
   * awaiting `append` has the §32.9 guarantee: the event is recorded before it
   * is considered processed.
   */
  append(envelope: EventEnvelope): void {
    if (this.#closed) throw new Error("event store is closed");

    const line = `${JSON.stringify(this.#prepare(envelope))}\n`;
    const bytes = Buffer.byteLength(line);

    // Rotate *before* writing, so a segment never exceeds its cap and a line
    // is never split across two files — a split line is unparseable in both.
    if (this.#currentEvents > 0 && this.#currentBytes + bytes > this.#maxSegmentBytes) {
      this.#rotate();
    }

    const fd = this.#fd;
    if (fd === undefined) throw new Error("event store has no open segment");

    writeSync(fd, line);

    this.#currentBytes += bytes;
    this.#bytesWritten += bytes;
    this.#currentEvents++;
    this.#appended++;
    this.#writtenSequence = envelope.sequence;
    if (this.#currentFirstSequence === 0) this.#currentFirstSequence = envelope.sequence;
    this.#currentLastSequence = envelope.sequence;

    this.#sinceCheckpoint++;
    if (this.#sinceCheckpoint >= this.#checkpointEveryEvents) this.checkpoint();
  }

  /**
   * Flush to physical storage and record how far the log is known-safe.
   *
   * The manifest is rewritten too, so a reader that arrives mid-scan sees
   * accurate segment ranges rather than a stale snapshot.
   */
  checkpoint(): void {
    if (this.#closed) return;

    const fd = this.#fd;
    if (fd !== undefined) fsyncSync(fd);

    this.#durableSequence = this.#writtenSequence;
    this.#sinceCheckpoint = 0;
    this.#syncCurrentSegmentRecord();
    this.#writeManifest();
    this.#writeCheckpoint();
  }

  /** Checkpoint and release the file descriptor. */
  close(): void {
    if (this.#closed) return;
    this.checkpoint();
    if (this.#fd !== undefined) {
      closeSync(this.#fd);
      this.#fd = undefined;
    }
    this.#closed = true;
  }

  /**
   * Externalize an oversized payload.
   *
   * Only the payload moves; the envelope's identity, ordering and context stay
   * inline so the log remains navigable and greppable without resolving
   * anything (§35B.5's traceability depends on that).
   */
  #prepare(
    envelope: EventEnvelope,
  ): EventEnvelope | (Omit<EventEnvelope, "payload"> & { payload: ExternalBodyRef }) {
    const serializedPayload = JSON.stringify(envelope.payload) ?? "null";
    if (Buffer.byteLength(serializedPayload) <= this.#maxInlinePayloadBytes) {
      return envelope;
    }
    return { ...envelope, payload: this.#bodies.put(envelope.payload) };
  }

  #openSegment(ordinal: number): void {
    this.#currentOrdinal = ordinal;
    const path = this.paths.segment(ordinal);
    // "a" so an interrupted-then-resumed session appends rather than truncating.
    this.#fd = openSync(path, "a", 0o600);
    this.#currentBytes = existsSync(path) ? fstatSync(this.#fd).size : 0;
    this.#currentEvents = 0;
    this.#currentFirstSequence = 0;
    this.#currentLastSequence = 0;

    this.#segments.push({
      ordinal,
      filename: this.paths.segment(ordinal).split("/").pop() ?? "",
      firstSequence: 0,
      lastSequence: 0,
      events: 0,
      bytes: this.#currentBytes,
    });
  }

  #rotate(): void {
    const fd = this.#fd;
    if (fd !== undefined) {
      // fsync before closing: a rotated segment is finished, and a finished
      // segment that is only in the page cache is a segment a reader may find
      // truncated after a machine death.
      fsyncSync(fd);
      closeSync(fd);
    }
    this.#syncCurrentSegmentRecord();
    this.#openSegment(this.#currentOrdinal + 1);
    this.#writeManifest();
  }

  #syncCurrentSegmentRecord(): void {
    const index = this.#segments.findIndex((s) => s.ordinal === this.#currentOrdinal);
    if (index === -1) return;
    const existing = this.#segments[index];
    if (existing === undefined) return;
    this.#segments[index] = {
      ...existing,
      firstSequence: this.#currentFirstSequence || existing.firstSequence,
      lastSequence: this.#currentLastSequence || existing.lastSequence,
      events: this.#currentEvents,
      bytes: this.#currentBytes,
    };
  }

  #writeManifest(): void {
    this.#syncCurrentSegmentRecord();
    const manifest: Manifest = {
      version: 1,
      sessionId: this.#sessionId,
      segments: this.#segments,
    };
    writeFileSync(this.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  #writeCheckpoint(): void {
    const checkpoint: Checkpoint = {
      version: 1,
      sessionId: this.#sessionId,
      durableSequence: this.#durableSequence,
      writtenSequence: this.#writtenSequence,
      at: this.#now().toISOString(),
      segments: this.#segments.length,
    };
    writeFileSync(this.paths.checkpoint, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
