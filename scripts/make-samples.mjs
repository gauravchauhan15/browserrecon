#!/usr/bin/env node
/**
 * Regenerate the reference outputs in `docs/samples/`.
 *
 *   pnpm build && node scripts/make-samples.mjs
 *
 * Every file under `docs/samples/` is written by a real scan of a real
 * browser against a fixture application — nothing in it is hand-written or
 * illustrative. That is the point: a sample somebody typed is a description
 * of what the tool is supposed to do, and the reason for keeping these is to
 * see what it actually does.
 *
 * Two things are normalised, and only two:
 *
 *  - The fixture's port, which the OS picks per run, becomes a fixed one.
 *    Otherwise every regeneration is a whole-file diff.
 *  - The session directory in the paths, for the same reason.
 *
 * Durations, counts, ids, ordering and wording are left exactly as the tool
 * wrote them.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const samples = join(root, "docs", "samples");

const { dynamicSite, webmcpSite, startFixture } = await import(
  join(root, "packages/fixtures/dist/index.js")
);
const { run } = await import(join(root, "apps/cli/dist/index.js"));

/** The origin every sample is rewritten to, so the files diff cleanly. */
const STABLE_ORIGIN = "http://127.0.0.1:8080";
const STABLE_DIR = "/home/you/.output/sess_0001";

async function sample(name, app, pages) {
  const fixture = await startFixture(app());
  const outputRoot = mkdtempSync(join(tmpdir(), "br-sample-"));
  const terminal = [];

  const code = await run({
    argv: [
      "scan",
      fixture.origin,
      "--i-am-authorized",
      "--no-deny-loopback",
      "--allowed-origins",
      fixture.origin,
      "--out",
      outputRoot,
      "--max-pages",
      String(pages),
    ],
    io: {
      out: (line) => terminal.push(line),
      err: () => {},
      env: {},
      version: "0.1.0",
    },
  });
  if (code !== 0) throw new Error(`${name}: the sample scan exited ${code}`);

  const sessionDir = join(outputRoot, readdirSync(outputRoot).sort().at(-1));
  const target = join(samples, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const stabilise = (text) =>
    text
      .split(fixture.origin)
      .join(STABLE_ORIGIN)
      .split(sessionDir)
      .join(STABLE_DIR)
      // The terminal summary elides long paths from the left, so the whole
      // session directory never appears in it to be replaced.
      .replace(/…[^\s]*br-sample-[A-Za-z0-9]+\/sess_0001/g, `…${STABLE_DIR}`);

  for (const file of ["report.md", "surface.json", "attack-surface.json"]) {
    writeFileSync(join(target, file), stabilise(readFileSync(join(sessionDir, file), "utf8")));
  }

  // The first twenty events, so a reader can see what the model was built
  // from. The whole log is 80-odd KB of one fixture; §22.1 keeps it raw, and
  // on a real target it holds credentials, which is why only a fixture's
  // events are ever committed.
  const log = readFileSync(
    join(
      sessionDir,
      readdirSync(sessionDir).find((f) => f.startsWith("events-")),
    ),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .slice(0, 20)
    .join("\n");
  writeFileSync(join(target, "events.head.jsonl"), `${stabilise(log)}\n`);

  writeFileSync(join(target, "terminal.txt"), `${stabilise(terminal.join("\n"))}\n`);

  rmSync(outputRoot, { recursive: true, force: true });
  await fixture.close();
  console.log(`  wrote docs/samples/${name}/`);
}

console.log("Regenerating docs/samples/ from real scans:");
await sample("dynamic-site", dynamicSite, 8);
await sample("webmcp-site", webmcpSite, 4);
console.log("Done.");
