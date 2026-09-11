# Locked architectural decisions

Recorded per dev plan `BR-M0-15`. Section references (`§`) point into the build
plan. These are settled; changing one is a deliberate act that updates this
file and states what reversed it.

## Language and toolchain

| Decision      | Choice                                                               | Why                                                                                                               |
| ------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Language      | TypeScript, Node >= 22, ESM                                          | Puppeteer and chrome-devtools-mcp are both Node; anything else puts a language boundary through the browser layer |
| Monorepo      | pnpm workspaces                                                      | Strict about phantom dependencies, which is what keeps §2's package boundaries real rather than aspirational      |
| pnpm delivery | `packageManager` field + corepack                                    | No global install, no sudo, and the version is pinned in the repo so CI and contributors get exactly the same one |
| Build         | `tsc --build` project references                                     | Makes package boundaries fail at compile time, not review time                                                    |
| Tests         | Vitest                                                               | TS-native, fast, good snapshot support for the golden-output tests                                                |
| Lint / format | ESLint flat config + Prettier, `strict` + `noUncheckedIndexedAccess` | Non-negotiable in a codebase largely edited by agents                                                             |

## Browser layer

| Decision          | Choice                                   | Why                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser control   | Puppeteer                                | High-level actions for the Deterministic Explorer (§5A)                                                                                                                                                         |
| Runtime telemetry | **Raw CDP via Puppeteer's `CDPSession`** | §5.1 requires true `Network.*` event subscriptions. Chrome DevTools MCP's network tools are poll-based and window-bounded ("since last navigation"), which cannot satisfy an event store that must miss nothing |
| AI action channel | Chrome DevTools MCP, V5+ only            | The right tool for exposing a small curated action surface to a model — and the wrong transport for V1–V4 telemetry                                                                                             |
| Browser           | Chrome / Chromium only                   | Deliberate scope limit; cross-browser parity would be unused engineering                                                                                                                                        |

## Discovery

| Decision        | Choice                                                                                     | Why                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Default crawler | Katana — _suggested_, not required                                                         | External binary on `PATH`, never bundled. Same posture as Ollama                       |
| Substitution    | Three levels (§10D.1): pipe any crawler's URLs, declare one in config, or write an adapter | Katana produces hints; CDP produces intelligence. The dependency is genuinely optional |
| Always-on       | `BrowserNativeAdapter` (DOM + JS + robots.txt + sitemap.xml)                               | Makes Tier 0 useful with nothing installed                                             |

## JavaScript analysis

| Decision        | Choice                                                                                                           | Why                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analyzer        | **tree-sitter in Node**, behind a BrowserRecon-owned `JSAnalyzer` interface                                      | §10A.1 nominated jsluice, but jsluice is **Go** — unusable as a library from a TypeScript core. tree-sitter is the same underlying technology and is error-tolerant, which §10B.4 requires for minified bundles |
| jsluice         | Optional secondary CLI adapter; reference for extraction approach                                                | Reading its approach is fine; porting its code verbatim would require MIT attribution and must be a deliberate, recorded choice                                                                                 |
| Validation gate | `BR-M2-05` spike must prove a >= 5 MB minified bundle parses within §10B.9 bounds before anything is built on it | If the spike fails, fall back to shelling out to jsluice and record the reversal here                                                                                                                           |

## AI layer

| Decision         | Choice                                                                     | Why                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default model    | `qwen3:8b` (~5–6 GB)                                                       | A 9.3 GB default excludes modest machines, most contributors, and all of CI from V4                                                                                                  |
| Tiers            | `qwen3:4b` (~2.5 GB) / `qwen3:8b` / `qwen3:14b`                            | Schema, vocabulary and grounding contracts hold on all three; only free-text quality varies                                                                                          |
| Default provider | Ollama via native `/api/chat` with `format: <json-schema>`                 | Strongest structured-output guarantee                                                                                                                                                |
| Portability      | `OpenAICompatibleProvider` for any `/v1` base URL, with a capability probe | Ollama's OpenAI-compatible layer does not fully honor `response_format: json_schema`; the probe selects schema-constrained generation or prompt-enforced JSON with strict validation |

## Data model

| Decision           | Choice                                                                      | Why                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| IDs                | **Deterministic, sequence-based** (`evt_000001`) — never random UUIDs       | Golden-output tests (§36.2) cannot assert against random values. This is a hard requirement, and expensive to retrofit |
| Persistence        | Append-only JSONL + checkpoints. No SQLite in V1                            | §42 lists SQLite as not required initially; revisit only if export performance demands it                              |
| Redaction boundary | Event store raw and local-only; reports, exports and model prompts redacted | The raw store is the evidence base correlation depends on (§37.2)                                                      |
| Provenance         | Set where a value is created, never at export                               | `static_context_inferred` sits outside the main chain and must be filterable                                           |

## Project

| Decision             | Choice                                | Why                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License              | **Apache-2.0**                        | Explicit patent grant and retaliation clause matter in a commercially active space; stated contribution terms; withheld trademark rights. Permits commercial repackaging — a consequence accepted deliberately in exchange for adoption |
| CLA                  | None; inbound = outbound              | Contributors retain copyright in their contributions                                                                                                                                                                                    |
| Contribution posture | Public, **closed to unsolicited PRs** | Single maintainer who cannot deeply audit incoming code should not accept it into a tool that handles credentials                                                                                                                       |
| Telemetry            | None, ever, by default                | Enforced by a network-egress test, not just documented                                                                                                                                                                                  |
| Code location        | Outside cloud-synced storage          | `.output/` holds unredacted credentials and captured data; syncing it to any cloud tenant is unacceptable, and `node_modules` breaks sync clients                                                                                       |

## Testing

Decided while building M0's test foundation (`BR-M0-13`, `BR-M0-14`), and
recorded because each one is a boundary that would be easy to erode later.

| Decision                    | Choice                                                                          | Why                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture server              | `node:http`, **not Express**                                                    | The dev plan said Express. Fixtures serve fixed strings through a dozen routes; Express adds ~30 packages for the license gate to vet and every contributor to trust, replacing ~40 lines of routing. `FixtureApp` says nothing about how it is served, so this is reversible in one file |
| Fixture determinism         | Enforced by a source scan, not by convention                                    | A test fails the build if any fixture source reaches for `Date.now`, `Math.random`, `randomUUID`, `performance.now` or `process.hrtime`. A determinism guarantee everyone has to remember will not survive the remaining §36.1 fixtures                                                   |
| Golden: missing baseline    | **Fails.** Never auto-created                                                   | Auto-creating means any lost baseline — merge conflict, `git clean`, renamed test — is regenerated from whatever the code does today, so the bug becomes the expected answer and the commit looks green                                                                                   |
| Golden: recording           | `pnpm test:golden:update` only, and **refused under CI** even with the flag set | A job that rewrites its own expectations always passes. The refusal lives in the harness, not only in the script a workflow happens to call                                                                                                                                               |
| Golden: over-masking        | Every mask rule's hit count is stored **inside the baseline**                   | Under-masking fails loudly and is fixed in minutes; over-masking passes forever while asserting nothing. Recording the counts makes "this now hides more" a reviewable diff                                                                                                               |
| Test files are type-checked | Separate `tsconfig.test.json` (`noEmit`), its own gate                          | Package tsconfigs exclude tests so they never reach `dist/`, which also left them unchecked by `tsc`, by eslint's non-type-aware ruleset, and by vitest's esbuild transpile. The gate found a helper type that had silently disabled checking on 16 call sites                            |
| Secret-scan exceptions      | Allowlist **values that cannot be real**, never file paths                      | A `paths` exemption was tried and rejected after probing it: a planted `sk_live_` key in an exempted file went undetected. Redaction tests must contain credential-shaped strings, but a real one pasted beside them still has to fail                                                    |

## Deviations from the plan as written

| Deviation                                                         | Reason                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §31's full package tree is **not** scaffolded up front            | Only packages with an active story are created; `scripts/new-package.mjs` adds the rest in one command. 35 empty packages with placeholder tests asserting nothing is permanent noise, and contradicts "no half-finished implementations" |
| Fixtures live in `packages/fixtures`, not a top-level `fixtures/` | Matches where every other package lives and where the workspace globs already pointed. `test-utils` had already established that test-only code sits in `packages/` and is marked `private`                                               |
| `tests/*` are workspace packages                                  | `tests/golden` has real dependencies and is imported by later stories, so it needs a `package.json` like anything else. `tests/*` added to `pnpm-workspace.yaml`                                                                          |
