# M0 gate — foundation verified

Dev plan `BR-M0-15`. The gate asks one question: **does this work for someone
who is not the author, on a machine that has never seen it?**

A developer's own laptop cannot answer that honestly — it already has every
dependency installed, every artifact built, and every uncommitted file sitting
where the code expects it. So the evidence below comes from a fresh `git clone`
of the public remote into an empty directory, not from the working copy.

|             |                                                                                       |
| ----------- | ------------------------------------------------------------------------------------- |
| Verified at | `72be959`                                                                             |
| Date        | 2026-09-11                                                                            |
| Method      | `git clone` → `pnpm install --frozen-lockfile` → `pnpm run build` → `pnpm run verify` |
| Host        | macOS, Node v24.15.0, pnpm 12.3.4 via corepack                                        |

## What passed

**Clean clone → install → build → green.** All eight verify gates, 521 tests.

| Gate            | Result                                                     |
| --------------- | ---------------------------------------------------------- |
| typecheck       | pass                                                       |
| typecheck tests | pass                                                       |
| lint            | pass                                                       |
| format          | pass                                                       |
| test            | pass — 521 tests                                           |
| licenses        | pass — 185 packages, all permissive                        |
| schemas         | pass — committed JSON Schema matches its TypeScript source |
| secret scan     | pass — full history, 17 commits                            |

**The claim the gate names specifically:** a synthetic event log written,
rotated, streamed and golden-compared with no browser involved. The `event-log`
golden subject does exactly this — a walk over a local fixture recorded through
the real event store, producing 28 events across 4 rotated segments plus a
manifest and checkpoint, read back gapless and in order, and compared against a
committed baseline.

That it happens with no browser is not a claim resting on observation. **There
is no browser driver in the dependency tree at all** — no Puppeteer, no
Playwright, no `chrome-*` package. The entire workspace declares two external
runtime dependencies: `commander` and `yaml`.

**The CLI runs from a clean clone.** `version`, `doctor`, `schema` and
`config validate <url>` all behave correctly with nothing installed beyond the
lockfile.

**The `clean-install` CI job's remaining step.** `pnpm --filter
@browserrecon/cli pack` produces a 32-file tarball carrying `bin/`, `dist/`,
`LICENSE` and `README.md`.

## What this gate does _not_ prove

Recorded honestly, because a gate that overstates itself is worse than no gate.

- **The Node 22 leg of the CI matrix.** Only Node 24 was available on the
  verifying host. CI runs both; that leg is proven there, not here.
- **Linux.** Verification was on macOS. CI runs `ubuntu-latest`, which is the
  only place the Linux paths — including Chrome detection via `PATH` rather
  than an app bundle — are exercised.
- **A standalone install of the packed CLI.** `pnpm pack` rewrites
  `workspace:*` to `0.0.0`, which resolves to nothing on a machine without the
  monorepo. Installing and running the tarball in isolation needs the packages
  published or bundled — that is M7 packaging work, and the dev plan already
  assigns extending this check to `BR-M1-31`.
- **Anything touching a real target.** M0 contains no browser and makes no
  outbound connection. The first story that contacts a target is `BR-M1-01`.

## The foundation M1 builds on

|                               |                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Packages                      | 10 — `core`, `config`, `policy`, `events`, `event-store`, `authorization`, `test-utils`, `fixtures`, `cli`, `golden` |
| Tests                         | 521 across 39 files                                                                                                  |
| External runtime dependencies | 2 (`commander`, `yaml`)                                                                                              |
| Verify gates                  | 8                                                                                                                    |
| Commits                       | 17                                                                                                                   |

Every gate in this repo has been probe-verified by deliberately breaking it —
the license allowlist, schema drift, README drift, the egress guard, the
gitleaks allowlist, SIGKILL durability, fixture determinism, golden baselines,
and the test type-check. A gate nobody has watched fail is a gate nobody knows
works.
