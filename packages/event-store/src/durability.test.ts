/**
 * The two claims that cannot be tested by calling functions politely.
 *
 * Everything in store.test.ts exercises the store through its API. These two
 * exercise the guarantees themselves: an actual SIGKILL mid-write, and actual
 * memory behaviour on a file far larger than the heap allowance. A durability
 * claim verified only by "we did not call close()" is not verified.
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAllEvents, readEvents } from "./reader.js";
import { sessionPaths } from "./layout.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "br-durability-"));

/** Repo root, so a child process can import the built package. */
const REPO_ROOT = process.cwd();

describe("SIGKILL mid-scan", () => {
  it("leaves a parseable log containing everything appended before the kill", () => {
    // BR-M0-09's headline criterion, tested for real: a child appends in a
    // tight loop and is killed without warning. SIGKILL cannot be caught, so
    // no cleanup handler runs — exactly the Chrome-crashed / OOM-killed case.
    const d = dir();
    const script = join(d, "writer.mjs");

    writeFileSync(
      script,
      `
      import { EventStore } from "${join(REPO_ROOT, "packages/event-store/dist/index.js")}";
      import { createEnvelope } from "${join(REPO_ROOT, "packages/events/dist/index.js")}";

      const store = new EventStore({
        dir: ${JSON.stringify(d)},
        sessionId: "sess_0001",
        checkpointEveryEvents: 1000000,
      });

      let sequence = 0;
      // Signal readiness only after some events are definitely on disk.
      for (let i = 0; i < 200; i++) {
        store.append(createEnvelope({
          event_id: "evt_" + String(++sequence).padStart(6, "0"),
          session_id: "sess_0001",
          sequence,
          timestamp: "2026-09-10T09:00:00.000Z",
          type: "network_request",
          provenance: "observed",
          auth_context: "anonymous",
          payload: { i },
        }));
      }
      process.stdout.write("ready\\n");

      // Keep writing until killed.
      for (;;) {
        store.append(createEnvelope({
          event_id: "evt_" + String(++sequence).padStart(6, "0"),
          session_id: "sess_0001",
          sequence,
          timestamp: "2026-09-10T09:00:00.000Z",
          type: "network_request",
          provenance: "observed",
          auth_context: "anonymous",
          payload: { i: sequence },
        }));
      }
      `,
    );

    // A supervisor process spawns the writer and SIGKILLs it. SIGKILL cannot
    // be trapped, so no exit handler, flush or finally block runs — only what
    // append() already put on disk survives.
    const kill = spawnSync(process.execPath, ["-e", KILLER_SOURCE, script], {
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(kill.stdout, kill.stderr).toContain("killed");

    // The log must be readable, and must contain the events written before
    // the kill. A trailing partial line is expected and tolerated.
    const problems: string[] = [];
    return readAllEvents(d, { onProblem: (p) => void problems.push(p.kind) }).then((events) => {
      expect(events.length).toBeGreaterThanOrEqual(200);

      // Gapless and ordered, right up to wherever it stopped.
      const sequences = events.map((e) => e.sequence);
      expect(sequences).toEqual(sequences.map((_, i) => i + 1));

      // At most one unusable line, and only ever at the very end.
      expect(problems.length).toBeLessThanOrEqual(1);
      for (const kind of problems) {
        expect(["truncated_tail", "malformed_json"]).toContain(kind);
      }
    });
  }, 60_000);
});

/**
 * Runs the writer as a grandchild and SIGKILLs it shortly after it reports
 * readiness. Kept as a string so the child is a real separate process rather
 * than something vitest could keep alive.
 */
const KILLER_SOURCE = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[1]], { stdio: ["ignore", "pipe", "pipe"] });

let ready = false;
child.stdout.on("data", (chunk) => {
  if (!ready && String(chunk).includes("ready")) {
    ready = true;
    // Let it write a little longer, then kill without warning.
    setTimeout(() => child.kill("SIGKILL"), 50);
  }
});

child.on("exit", (code, signal) => {
  process.stdout.write(signal === "SIGKILL" ? "killed\\n" : "exited " + code + " " + signal + "\\n");
});
`;

describe("streaming reader memory", () => {
  it("uses memory bounded by line length, not by file size", async () => {
    // BR-M0-09 asks for a 1 GB log. Generating one in CI costs minutes of
    // wall clock and a gigabyte of runner disk for no extra signal, so this
    // tests the actual property — memory independent of file size — with a
    // file that is an order of magnitude larger than the heap growth allowed.
    // A reader that loaded the file would need >64 MB and fail outright.
    const d = dir();
    const targetBytes = 64 * 1024 * 1024;
    const path = sessionPaths(d).segment(1);

    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(path);
      out.on("error", reject);
      out.on("finish", () => resolve());

      let sequence = 0;
      let written = 0;

      const pump = (): void => {
        while (written < targetBytes) {
          sequence++;
          const line =
            JSON.stringify({
              event_id: `evt_${String(sequence).padStart(6, "0")}`,
              session_id: "sess_0001",
              timestamp: "2026-09-10T09:00:00.000Z",
              sequence,
              type: "network_request",
              provenance: "observed",
              auth_context: "anonymous",
              payload: { filler: "x".repeat(200) },
            }) + "\n";
          written += Buffer.byteLength(line);
          if (!out.write(line)) {
            out.once("drain", pump);
            return;
          }
        }
        out.end();
      };
      pump();
    });

    expect(statSync(path).size).toBeGreaterThan(targetBytes);

    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let count = 0;

    for await (const event of readEvents(d)) {
      count++;
      // Sample rather than measure every iteration; measuring is not free.
      if (count % 5000 === 0) {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }
      // Touch the event so it cannot be optimized away.
      if (event.sequence < 0) throw new Error("impossible");
    }

    const growthMb = (peak - before) / (1024 * 1024);
    expect(count).toBeGreaterThan(100_000);
    expect(growthMb, `heap grew ${growthMb.toFixed(1)} MB streaming a 64 MB log`).toBeLessThan(
      32,
    );
  }, 180_000);
});
