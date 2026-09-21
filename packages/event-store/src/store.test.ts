import { appendFileSync, mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { EventStore, type Checkpoint, type EventStoreOptions, type Manifest } from "./store.js";
import { readAllEvents, readEvents, readManifest, payloadIsExternal } from "./reader.js";
import { isExternalBodyRef, BodyStore } from "./bodies.js";
import { sessionPaths } from "./layout.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "br-store-"));

function envelope(sequence: number, payload: unknown = {}): EventEnvelope {
  return createEnvelope({
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    session_id: "sess_0001",
    sequence,
    timestamp: "2026-09-10T09:00:00.000Z",
    type: "network_request",
    provenance: "observed",
    auth_context: "anonymous",
    payload,
  });
}

/**
 * A store in a scratch directory, with the tuning knobs overridable per test.
 *
 * The options type used to be derived as `Parameters<typeof
 * EventStore.prototype.constructor>[0]`, which resolves to `Function`'s
 * parameters rather than the class constructor's — so it collapsed to `never`
 * and every call site's options object went unchecked. Naming
 * `EventStoreOptions` directly is both correct and readable. (Found the day
 * test files started being type-checked; nothing had flagged it for four
 * milestones.)
 */
const store = (d: string, options: Partial<EventStoreOptions> = {}): EventStore =>
  new EventStore({ dir: d, sessionId: "sess_0001", ...options });

describe("append and read", () => {
  it("round-trips events in sequence order", async () => {
    const d = dir();
    const s = store(d);
    for (let i = 1; i <= 5; i++) s.append(envelope(i));
    s.close();

    const events = await readAllEvents(d);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("writes one JSON object per line", () => {
    const d = dir();
    const s = store(d);
    s.append(envelope(1));
    s.append(envelope(2));
    s.close();

    const raw = readFileSync(sessionPaths(d).segment(1), "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("creates the session directory and files owner-only", () => {
    // The directory holds unredacted cookies, tokens and request bodies
    // (§37.2). Other local accounts have no business reading it.
    const d = join(dir(), "nested", "session");
    const s = store(d);
    s.append(envelope(1));
    s.close();

    expect(statSync(d).mode & 0o077).toBe(0);
    expect(statSync(sessionPaths(d).segment(1)).mode & 0o077).toBe(0);
  });

  it("refuses to append after close", () => {
    const s = store(dir());
    s.close();
    expect(() => s.append(envelope(1))).toThrow(/closed/);
  });

  it("reads an empty session without complaint", async () => {
    const d = dir();
    store(d).close();
    expect(await readAllEvents(d)).toEqual([]);
  });
});

describe("durability against process death", () => {
  it("has every appended event on disk before append returns", async () => {
    // The §32.9 guarantee, and the failure that actually happens during a
    // scan. Nothing is buffered in-process waiting for a flush, so reading
    // the file from a *different* handle sees the data immediately.
    const d = dir();
    const s = store(d, { checkpointEveryEvents: 1_000_000 });

    s.append(envelope(1));
    s.append(envelope(2));

    // Deliberately do NOT close or checkpoint — simulate the process dying here.
    const events = await readAllEvents(d);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("survives a truncated final line and keeps everything before it", async () => {
    // BR-M0-09 acceptance criterion. A half-written last line is the expected
    // shape of an interrupted scan, not corruption — and refusing to read the
    // file would discard the evidence durability exists to protect.
    const d = dir();
    const s = store(d);
    for (let i = 1; i <= 3; i++) s.append(envelope(i));
    s.close();

    const path = sessionPaths(d).segment(1);
    const raw = readFileSync(path, "utf8");
    // Chop the file mid-way through what would have been a fourth line.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, `${raw}{"event_id":"evt_000004","sess`);

    const problems: string[] = [];
    const events = await readAllEvents(d, {
      onProblem: (p) => void problems.push(p.kind),
    });

    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(problems).toEqual(["truncated_tail"]);
  });

  it("ignores a truncated tail silently when no handler is given", async () => {
    const d = dir();
    const s = store(d);
    s.append(envelope(1));
    s.close();

    const { appendFileSync } = await import("node:fs");
    appendFileSync(sessionPaths(d).segment(1), '{"event_id":"evt_0000');

    await expect(readAllEvents(d)).resolves.toHaveLength(1);
  });

  it("reports a malformed but complete line separately from a truncated one", async () => {
    const d = dir();
    const s = store(d);
    s.append(envelope(1));
    s.close();

    const { appendFileSync } = await import("node:fs");
    appendFileSync(sessionPaths(d).segment(1), "{not valid json}\n");

    const problems: string[] = [];
    await readAllEvents(d, { onProblem: (p) => void problems.push(p.kind) });
    expect(problems).toEqual(["malformed_json"]);
  });

  it("rejects a well-formed line that is not a valid envelope", async () => {
    const d = dir();
    const s = store(d);
    s.append(envelope(1));
    s.close();

    const { appendFileSync } = await import("node:fs");
    appendFileSync(sessionPaths(d).segment(1), `${JSON.stringify({ hello: "world" })}\n`);

    const problems: string[] = [];
    const events = await readAllEvents(d, { onProblem: (p) => void problems.push(p.kind) });
    expect(events).toHaveLength(1);
    expect(problems).toEqual(["invalid_envelope"]);
  });
});

describe("checkpoints", () => {
  it("distinguishes written from durable", () => {
    // Two different guarantees: writtenSequence survives process death,
    // durableSequence survives machine death. Collapsing them would overstate
    // the protection.
    const d = dir();
    const s = store(d, { checkpointEveryEvents: 1_000_000 });
    s.append(envelope(1));
    s.append(envelope(2));

    expect(s.stats.writtenSequence).toBe(2);
    expect(s.stats.durableSequence).toBe(0);

    s.checkpoint();
    expect(s.stats.durableSequence).toBe(2);
  });

  it("checkpoints automatically at the configured interval", () => {
    const d = dir();
    const s = store(d, { checkpointEveryEvents: 2 });
    s.append(envelope(1));
    expect(s.stats.durableSequence).toBe(0);
    s.append(envelope(2));
    expect(s.stats.durableSequence).toBe(2);
  });

  it("records how far the log is known-safe, so resume need not guess", () => {
    const d = dir();
    const s = store(d, { now: () => new Date("2026-09-10T10:00:00Z") });
    s.append(envelope(1));
    s.close();

    const checkpoint = JSON.parse(
      readFileSync(sessionPaths(d).checkpoint, "utf8"),
    ) as Checkpoint;

    expect(checkpoint).toMatchObject({
      version: 1,
      sessionId: "sess_0001",
      durableSequence: 1,
      writtenSequence: 1,
      at: "2026-09-10T10:00:00.000Z",
    });
  });

  it("checkpoints on close", () => {
    const d = dir();
    const s = store(d, { checkpointEveryEvents: 1_000_000 });
    s.append(envelope(1));
    s.close();
    expect(existsSync(sessionPaths(d).checkpoint)).toBe(true);
  });
});

describe("rotation", () => {
  it("rotates once a segment reaches its cap", async () => {
    const d = dir();
    // Small cap so a handful of events spans several segments.
    const s = store(d, { maxSegmentBytes: 400 });
    for (let i = 1; i <= 12; i++) s.append(envelope(i));
    s.close();

    expect(s.stats.segments).toBeGreaterThan(1);
    const events = await readAllEvents(d);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("never splits a line across two segments", () => {
    // A split line is unparseable in both files, so rotation happens before
    // the write rather than after.
    const d = dir();
    const s = store(d, { maxSegmentBytes: 400 });
    for (let i = 1; i <= 12; i++) s.append(envelope(i));
    s.close();

    const manifest = readManifest(d);
    for (const segment of manifest?.segments ?? []) {
      const raw = readFileSync(join(d, segment.filename), "utf8");
      if (raw === "") continue;
      expect(raw.endsWith("\n")).toBe(true);
      for (const line of raw.trimEnd().split("\n")) {
        expect(() => JSON.parse(line), `${segment.filename}: ${line}`).not.toThrow();
      }
    }
  });

  it("writes an ordered manifest with sequence ranges", () => {
    // BR-M0-09 acceptance criterion: ordered and resumable.
    const d = dir();
    const s = store(d, { maxSegmentBytes: 400 });
    for (let i = 1; i <= 12; i++) s.append(envelope(i));
    s.close();

    const manifest = readManifest(d) as Manifest;
    expect(manifest.version).toBe(1);
    expect(manifest.segments.length).toBeGreaterThan(1);

    const ordinals = manifest.segments.map((seg) => seg.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));

    // Ranges must be contiguous and non-overlapping, or a resume would either
    // skip events or replay them.
    const populated = manifest.segments.filter((seg) => seg.events > 0);
    for (let i = 1; i < populated.length; i++) {
      const previous = populated[i - 1];
      const current = populated[i];
      if (previous === undefined || current === undefined) continue;
      expect(current.firstSequence).toBe(previous.lastSequence + 1);
    }
  });

  it("allows a single event larger than the segment cap", () => {
    // Rotating on an empty segment would loop forever; the cap is a target,
    // not a hard invariant when one event exceeds it alone.
    const d = dir();
    const s = store(d, { maxSegmentBytes: 100, maxInlinePayloadBytes: 1_000_000 });
    s.append(envelope(1, { blob: "x".repeat(500) }));
    s.close();
    expect(s.stats.appended).toBe(1);
  });
});

describe("reading without a manifest", () => {
  it("discovers segments from disk, so losing the manifest does not lose the log", async () => {
    const d = dir();
    const s = store(d, { maxSegmentBytes: 400 });
    for (let i = 1; i <= 10; i++) s.append(envelope(i));
    s.close();

    const { rmSync } = await import("node:fs");
    rmSync(sessionPaths(d).manifest);

    const events = await readAllEvents(d);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("ignores a corrupt manifest and falls back to discovery", async () => {
    const d = dir();
    const s = store(d);
    s.append(envelope(1));
    s.close();

    const { writeFileSync } = await import("node:fs");
    writeFileSync(sessionPaths(d).manifest, "not json");

    expect(readManifest(d)).toBeUndefined();
    expect(await readAllEvents(d)).toHaveLength(1);
  });
});

describe("oversized payloads", () => {
  it("externalizes a large payload and references it by hash", async () => {
    const d = dir();
    const s = store(d, { maxInlinePayloadBytes: 200 });
    s.append(envelope(1, { body: "x".repeat(1000) }));
    s.close();

    const [event] = await readAllEvents(d);
    expect(event).toBeDefined();
    if (event === undefined) return;

    expect(payloadIsExternal(event)).toBe(true);
    expect(isExternalBodyRef(event.payload)).toBe(true);
    if (!isExternalBodyRef(event.payload)) return;
    expect(event.payload.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(s.stats.externalizedBodies).toBe(1);
  });

  it("keeps identity and context inline, so the log stays navigable", async () => {
    // Only the payload moves. §35B.5's traceability depends on being able to
    // grep the log for an id without resolving anything.
    const d = dir();
    const s = store(d, { maxInlinePayloadBytes: 200 });
    s.append(envelope(42, { body: "y".repeat(1000) }));
    s.close();

    const raw = readFileSync(sessionPaths(d).segment(1), "utf8");
    expect(raw).toContain("evt_000042");
    expect(raw).toContain("network_request");
    expect(raw).not.toContain("yyyy");
  });

  it("resolves an externalized payload back to the original", async () => {
    const d = dir();
    const original = { body: "z".repeat(1000), method: "POST" };
    const s = store(d, { maxInlinePayloadBytes: 200 });
    s.append(envelope(1, original));
    s.close();

    const [event] = await readAllEvents(d);
    if (event === undefined || !isExternalBodyRef(event.payload))
      throw new Error("expected ref");

    const bodies = new BodyStore(sessionPaths(d).bodies);
    expect(await bodies.get(event.payload)).toEqual(original);
  });

  it("stores identical bodies once", async () => {
    // Content addressing gets deduplication for free: the same API response
    // observed on every visit costs one file, not one per event.
    const d = dir();
    const s = store(d, { maxInlinePayloadBytes: 200 });
    const shared = { body: "same".repeat(300) };
    s.append(envelope(1, shared));
    s.append(envelope(2, { ...shared }));
    s.close();

    expect(s.stats.externalizedBodies).toBe(1);
    expect(s.stats.deduplicatedBodies).toBe(1);
  });

  it("leaves a small payload inline", async () => {
    const d = dir();
    const s = store(d, { maxInlinePayloadBytes: 64 * 1024 });
    s.append(envelope(1, { method: "GET", status: 200 }));
    s.close();

    const [event] = await readAllEvents(d);
    expect(payloadIsExternal(event as EventEnvelope)).toBe(false);
    expect(event?.payload).toEqual({ method: "GET", status: 200 });
    expect(existsSync(sessionPaths(d).bodies)).toBe(false);
  });
});

describe("resume support", () => {
  it("skips events at or below a given sequence", async () => {
    const d = dir();
    const s = store(d);
    for (let i = 1; i <= 6; i++) s.append(envelope(i));
    s.close();

    const events = await readAllEvents(d, { afterSequence: 4 });
    expect(events.map((e) => e.sequence)).toEqual([5, 6]);
  });

  it("appends to an existing session rather than truncating it", async () => {
    // A resumed scan must extend the log. Truncating would destroy the
    // evidence the first run collected.
    //
    // This assertion used to pass without `resume: true`, because three
    // small events all land in segment 1 and reopening it happened to
    // produce the right order. It said nothing about a log that had
    // rotated, which is where the ordering actually broke — see "keeps the
    // log in sequence order across runs" below.
    const d = dir();
    const first = store(d);
    first.append(envelope(1));
    first.append(envelope(2));
    first.close();

    const second = new EventStore({ dir: d, sessionId: "sess_0001", resume: true });
    second.append(envelope(3));
    second.close();

    const events = await readAllEvents(d);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });
});

describe("resuming a session", () => {
  const resumeEvent = (sequence: number): EventEnvelope =>
    createEnvelope({
      sequence,
      event_id: `evt_${String(sequence).padStart(6, "0")}`,
      session_id: "sess_0001",
      type: "page_loaded",
      timestamp: "1970-01-01T00:00:00.000Z",
      auth_context: "anonymous",
      provenance: "observed",
      payload: { n: sequence },
    });

  async function sequencesIn(dir: string): Promise<number[]> {
    const out: number[] = [];
    for await (const event of readEvents(dir)) out.push(event.sequence);
    return out;
  }

  it("keeps the log in sequence order across runs", async () => {
    // The measured failure this exists to prevent: a second store over the
    // same directory reopened segment 1, appended into the middle of it,
    // and the log read back as 1,2,13,3,4,14,… — every event present, the
    // order destroyed, and nothing reporting a problem.
    const dir = mkdtempSync(join(tmpdir(), "br-store-resume-"));

    const first = new EventStore({ dir, sessionId: "sess_0001", maxSegmentBytes: 400 });
    for (let sequence = 1; sequence <= 12; sequence += 1) first.append(resumeEvent(sequence));
    first.close();

    const second = new EventStore({
      dir,
      sessionId: "sess_0001",
      maxSegmentBytes: 400,
      resume: true,
    });
    for (let sequence = 13; sequence <= 18; sequence += 1) second.append(resumeEvent(sequence));
    second.close();

    const sequences = await sequencesIn(dir);
    expect(sequences).toEqual([...Array(18)].map((_, index) => index + 1));
  });

  it("keeps the earlier runs' segments in the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "br-store-resume-"));
    const first = new EventStore({ dir, sessionId: "sess_0001", maxSegmentBytes: 400 });
    for (let sequence = 1; sequence <= 8; sequence += 1) first.append(resumeEvent(sequence));
    const segmentsBefore = first.stats.segments;
    first.close();

    const second = new EventStore({ dir, sessionId: "sess_0001", resume: true });
    second.append(resumeEvent(9));
    second.close();

    const manifest = readManifest(dir);
    expect(manifest?.segments.length).toBe(segmentsBefore + 1);
    // Ranges from the first run survive rather than being overwritten with
    // the second run's.
    expect(manifest?.segments[0]?.firstSequence).toBe(1);
  });

  it("continues from the sequence the log reached", () => {
    const dir = mkdtempSync(join(tmpdir(), "br-store-resume-"));
    const first = new EventStore({ dir, sessionId: "sess_0001" });
    for (let sequence = 1; sequence <= 5; sequence += 1) first.append(resumeEvent(sequence));
    first.close();

    // A resumed scan has to know where to start numbering, or it writes
    // duplicate sequences that no reader can order.
    const second = new EventStore({ dir, sessionId: "sess_0001", resume: true });
    expect(second.stats.writtenSequence).toBe(5);
    second.close();
  });

  it("opens a fresh segment rather than appending after a possibly torn line", async () => {
    // The previous run may have died mid-line. Appending after a torn line
    // splices two events into one unparseable record; a new segment keeps
    // the damage where the reader's per-line handling already copes.
    const dir = mkdtempSync(join(tmpdir(), "br-store-resume-"));
    const first = new EventStore({ dir, sessionId: "sess_0001" });
    first.append(resumeEvent(1));
    first.close();

    appendFileSync(join(dir, "events-0001.jsonl"), '{"event_id":"evt_0000');

    const second = new EventStore({ dir, sessionId: "sess_0001", resume: true });
    second.append(resumeEvent(2));
    second.close();

    const problems: unknown[] = [];
    const sequences: number[] = [];
    for await (const event of readEvents(dir, { onProblem: (p) => problems.push(p) })) {
      sequences.push(event.sequence);
    }
    expect(sequences).toEqual([1, 2]);
    expect(problems).toHaveLength(1);
  });

  it("refuses to open a new session over an existing one", () => {
    // The silent-corruption case, now loud.
    const dir = mkdtempSync(join(tmpdir(), "br-store-resume-"));
    const first = new EventStore({ dir, sessionId: "sess_0001" });
    first.append(resumeEvent(1));
    first.close();

    expect(() => new EventStore({ dir, sessionId: "sess_0001" })).toThrow(/resume: true/);
  });

  it("refuses to resume a directory holding a different session", () => {
    // Appending one session's events to another's produces a log whose
    // every downstream claim is about two scans at once.
    const dir = mkdtempSync(join(tmpdir(), "br-store-resume-"));
    const first = new EventStore({ dir, sessionId: "sess_0001" });
    first.append(resumeEvent(1));
    first.close();

    expect(() => new EventStore({ dir, sessionId: "sess_0002", resume: true })).toThrow(
      /holds session sess_0001/,
    );
  });

  it("refuses to resume a directory with nothing to resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "br-store-resume-"));
    expect(() => new EventStore({ dir, sessionId: "sess_0001", resume: true })).toThrow(
      /no readable segments/,
    );
  });
});
