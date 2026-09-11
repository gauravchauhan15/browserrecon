/**
 * Two projects, because browser tests and unit tests need opposite settings.
 *
 * Everything without a browser runs in parallel across workers, which is what
 * keeps a 600-test suite under two seconds.
 *
 * The browser tests cannot. Each file launches its own Chrome, and running
 * three of them at once turned a passing suite into a flake: on a machine with
 * under a gigabyte free, a form-submitting click stalled past a 60 second
 * timeout, then passed on the next run in a fifth of the time. That is not a
 * logic bug to hunt — it is memory pressure, and CI runners are more
 * constrained than a laptop, not less. So browser files run one at a time.
 *
 * The cost is wall-clock: the browser project takes roughly half a minute. The
 * alternative is a suite that fails for reasons unrelated to the change under
 * test, which is how people learn to re-run CI instead of reading it.
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["{apps,packages}/**/src/**/*.test.ts", "tests/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "packages/browser/**"],
    },
  },
  {
    test: {
      name: "browser",
      include: ["packages/browser/**/src/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      // One Chrome at a time.
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
