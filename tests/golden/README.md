# @browserrecon/golden

Golden-output tests: run the pipeline against a fixture, normalize the result,
compare it to a committed baseline. Build plan §36.2, §23; dev plan BR-M0-14.

This is the only test that catches a change nobody thought to assert — a field
quietly dropped from an export, a correlation that stops firing, a schema that
drifts from what downstream consumers read.

## Owns

- The masking rules (`src/masking.ts`) — the complete, declared set.
- Normalization of JSON, JSONL and plain text, with a mask report
  (`src/normalize.ts`).
- Baseline storage, comparison, the readable diff, and the update flow
  (`src/snapshot.ts`).
- The golden subjects themselves (`src/*.golden.test.ts`) and their committed
  baselines (`baselines/`).

## Does not own

- Fixture applications — `@browserrecon/fixtures` (BR-M0-13).
- Assertions about AI output, which are statistical rather than exact —
  BR-M4-08.

## Running

```bash
pnpm test:golden          # compare against the committed baselines
pnpm test:golden:update   # record new baselines, then review the git diff
```

Both build first. Tests import workspace packages by name, which resolves to
each package's `dist/`, so an uncompiled source edit would otherwise be
invisible — and baselines recorded from stale output describe code that no
longer exists.

## Two design decisions that make this worth having

### A missing baseline is a failure

The obvious design writes the baseline on first run and compares afterwards. It
is also the design that makes golden tests worthless: the moment a baseline is
lost — a merge conflict resolved the lazy way, a `git clean`, a renamed test —
the next run recreates it from whatever the code currently does, and passes.
The bug becomes the expected answer, and the commit that did it looks green.

So a missing baseline fails and says how to record one. Writing only happens
when a human asks, and **never under CI**, even with the flag set: a job that
rewrites its own expectations always passes, which is worse than no test.

### Over-masking is the failure mode that hides

An under-masked baseline fails loudly and gets fixed in minutes. An over-masked
one passes forever while asserting nothing, and nobody notices, because green
looks the same either way.

Three things push against it. Rules live in one file, so the whole masking
surface reads in one sitting. Rules are keyed on field names wherever the field
is known, falling back to value patterns only where a value can appear
anywhere. And every rule's **hit count is recorded in the baseline** — so
masking more than before is a reviewable diff rather than continued green.

A test also pins the list of rule names, which means adding a rule cannot pass
unnoticed. Before adding one, check the field is genuinely nondeterministic
rather than a bug: a value that "changes every run" is often a missing injected
clock, or a random ID that should have been a counter.

## The complete masking surface

<!-- generated from MASK_RULES; a test fails if this drifts -->

| Rule              | Applies to                                                                       | Placeholder        | Why it is masked                                                                         |
| ----------------- | -------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `timestamp`       | fields: `timestamp`, `at`, `startedAt`, `finishedAt`, `observedAt`               | `<timestamp>`      | Wall-clock time of the run. The only field on every event that cannot be reproduced.     |
| `duration`        | fields: `durationMs`, `elapsedMs`, `ttfbMs`, `latencyMs`                         | `<duration-ms>`    | How long something took. Varies with machine load, not with behaviour.                   |
| `ephemeral-port`  | fields: `port`                                                                   | `<port>`           | Fixtures listen on an OS-assigned port so parallel tests cannot collide.                 |
| `tmpdir-path`     | pattern: `(?:\/private)?(?:\/var\/folders\/[^\s"]*?\/T\|\/tmp)\/[A-Za-z0-9._-]+` | `<tmpdir>`         | Session directories are created under the OS temp dir with a random suffix.              |
| `loopback-origin` | pattern: `http:\/\/127\.0\.0\.1:\d+`                                             | `<fixture-origin>` | A fixture's origin embeds its ephemeral port. Reaches URLs, Host headers and bodies.     |
| `home-path`       | pattern: `\/(?:Users\|home)\/[A-Za-z0-9._-]+`                                    | `<home>`           | Absolute paths differ per developer and would leak a username into a committed baseline. |

Everything not listed above is asserted exactly. In the current baselines that
means event IDs, sequence numbers, statuses, content types, byte counts,
segment boundaries and every byte of every fixture page.

## Subjects

| Baseline      | What it pins                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event-log`   | A fixture walk recorded through the real event store: 28 events across 4 rotated segments, plus the manifest and checkpoint. The end-to-end M0 pipeline with no browser in it. |
| `static-site` | Every page the static fixture serves, byte for byte.                                                                                                                           |
| `rest-api`    | Every response the API fixture returns, byte for byte.                                                                                                                         |

## Reviewing a baseline change

A diff here is a behaviour change. Read it the way you would read a change to
the code that produced it, and be suspicious of two things in particular: a
mask count that went up, and a baseline that got shorter.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
