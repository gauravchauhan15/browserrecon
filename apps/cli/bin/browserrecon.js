#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * Deliberately thin: it wires real stdio and the process exit code to `run`,
 * and does nothing else. Everything testable lives in the library, so the
 * binary itself needs no test of its own beyond the clean-install smoke check.
 */
import { createRequire } from "node:module";
import { run } from "../dist/index.js";

const { version } = createRequire(import.meta.url)("../package.json");

const code = await run({
  argv: process.argv.slice(2),
  io: {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    version,
  },
});

process.exitCode = code;
