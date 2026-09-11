import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore, readAllEvents, sessionPaths } from "@browserrecon/event-store";
import { createEnvelope, type EventEnvelope } from "@browserrecon/events";
import { staticSite, withFixture, type RunningFixture } from "@browserrecon/fixtures";
import { IdFactory } from "@browserrecon/core";
import { combine, normalizeJson, normalizeJsonl } from "./normalize.js";
import { expectGolden } from "./snapshot.js";
import { goldenEnvironment } from "./index.js";

/**
 * The end-to-end M0 pipeline, with no browser anywhere in it:
 *
 *   fixture -> events -> durable store (rotated) -> normalize -> baseline
 *
 * Synthesizing the events from real HTTP responses rather than from literals
 * is what makes this worth running. Literal events would prove the normalizer
 * can format a constant; these carry a genuinely nondeterministic origin (the
 * fixture's ephemeral port) and a genuinely nondeterministic clock, which is
 * precisely what masking has to survive.
 *
 * This is also the subject BR-M0-15's gate names: "a synthetic event log can
 * be written, rotated, streamed and golden-compared with no browser involved".
 */

const golden = goldenEnvironment(process.env, new URL("../baselines/", import.meta.url));

/** Fixed walk order — the input to the pipeline must itself be deterministic. */
const WALK: readonly string[] = [
  "/",
  "/about",
  "/products",
  "/products/1",
  "/products/2",
  "/products/3",
  "/products/9",
  "/contact",
  "/app.js",
  "/robots.txt",
  "/sitemap.xml",
  "/orphan",
  "/gone",
  "/nowhere",
];

/**
 * Small enough that this walk rotates the log several times.
 *
 * Rotation is part of what the gate asks to be golden-compared, and a segment
 * boundary is exactly the kind of thing that works until the day it does not.
 */
const MAX_SEGMENT_BYTES = 2_048;

/**
 * Guard against a subtle baseline flake.
 *
 * `segments.json` records each segment's byte count, which is asserted exactly
 * because rotation behaviour is what this subject is for. Those bytes are
 * counted BEFORE masking, so they include the fixture's port — and a port with
 * a different number of digits would shift every segment boundary and fail the
 * golden test for a reason nobody could guess from the diff.
 *
 * Every ephemeral range in practice (macOS 49152-65535, Linux 32768-60999) is
 * five digits, so this holds. Asserting it turns a mystery into one sentence
 * if some platform ever proves otherwise.
 */
function assertPortWidthMatchesBaseline(port: number): void {
  expect(
    String(port).length,
    "This baseline's segment byte counts assume a 5-digit ephemeral port. " +
      `This run got ${port}. Re-record with \`pnpm test:golden:update\` and note the ` +
      "platform in the commit, rather than accepting a shifting baseline.",
  ).toBe(5);
}

async function walkAndRecord(fixture: RunningFixture, dir: string): Promise<void> {
  assertPortWidthMatchesBaseline(fixture.port);

  const ids = new IdFactory(1);
  const store = new EventStore({
    dir,
    sessionId: ids.sessionId,
    maxSegmentBytes: MAX_SEGMENT_BYTES,
  });
  let sequence = 0;

  const emit = (type: "network_request" | "network_response", payload: unknown): void => {
    sequence += 1;
    const envelope: EventEnvelope = createEnvelope({
      event_id: ids.next("event"),
      session_id: ids.sessionId,
      sequence,
      type,
      provenance: "observed",
      auth_context: "anonymous",
      payload,
      // Timestamp deliberately omitted so the store stamps a real clock — the
      // masking rule has to earn its place against a genuine wall-clock value.
    });
    store.append(envelope);
  };

  for (const path of WALK) {
    const url = `${fixture.origin}${path}`;
    emit("network_request", { method: "GET", url });

    const response = await fetch(url, { redirect: "manual" });
    const body = await response.text();
    emit("network_response", {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.byteLength(body, "utf8"),
    });
  }

  store.checkpoint();
  store.close();
}

describe("synthetic event log", () => {
  it("matches its baseline after a fixture walk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "br-golden-log-"));
    await withFixture(staticSite(), async (fixture) => walkAndRecord(fixture, dir));

    const paths = sessionPaths(dir);
    const segments = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();

    // More than one, or the rotation half of the gate is not being exercised.
    expect(segments.length, "expected the log to rotate").toBeGreaterThan(1);

    const parts: [string, ReturnType<typeof normalizeJsonl>][] = segments.map((name) => [
      name,
      normalizeJsonl(readFileSync(join(dir, name), "utf8")),
    ]);
    parts.push([
      "segments.json",
      normalizeJson(JSON.parse(readFileSync(paths.manifest, "utf8"))),
    ]);
    parts.push([
      "checkpoint.json",
      normalizeJson(JSON.parse(readFileSync(paths.checkpoint, "utf8"))),
    ]);

    expectGolden("event-log", combine(parts), golden);
  });

  it("produces an identical baseline on a second, independent run", async () => {
    // Acceptance criterion: two consecutive runs on one fixture normalize to
    // the same output. Run twice here rather than trusting that the first run
    // matching a committed file proves it — a baseline recorded from a buggy
    // run would also match itself.
    const run = async (): Promise<string> => {
      const dir = mkdtempSync(join(tmpdir(), "br-golden-log-"));
      await withFixture(staticSite(), async (fixture) => walkAndRecord(fixture, dir));
      const segments = readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort();
      return combine(
        segments.map((name) => [name, normalizeJsonl(readFileSync(join(dir, name), "utf8"))]),
      ).text;
    };

    const [first, second] = await Promise.all([run(), run()]);
    expect(second).toBe(first);
  });

  it("streams back every event it wrote, gapless and in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "br-golden-log-"));
    await withFixture(staticSite(), async (fixture) => walkAndRecord(fixture, dir));

    const events = await readAllEvents(dir);
    expect(events).toHaveLength(WALK.length * 2);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: WALK.length * 2 }, (_, index) => index + 1),
    );
  });
});
