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

## Measured constraints that change what the plan can promise

Recorded because each was found by running the thing, not by reading a
specification, and each narrows a promise the build plan makes.

| Constraint                                                          | What it means                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CDP never reports WebSocket control frames** (BR-M1-05)           | §17A names "WebSocket pings" as its first example of the `keepalive` role. A real opcode-0x9 ping produces no DevTools Network event at all, so that case is unreachable for any CDP-based tool — this one or `chrome-devtools-mcp` alike. Application-level heartbeats, which is what real applications overwhelmingly send, are captured normally. A test pins the limitation so it fails if Chrome ever lifts it. |
| **Browser-process traffic is invisible to telemetry** (BR-M1-03)    | Every _target_ is watched — pages, iframes, workers — but Chrome's own background networking belongs to no target. It stays guarded by launch flags rather than by observation, and BR-M1-01's claim that it would become observable here was wrong.                                                                                                                                                                 |
| **Redirects are detected, not prevented** (BR-M1-02)                | The browser follows them before control returns, so `navigate` checks the URL first and the landing site after. Pre-emptive blocking needs request interception, which belongs with the telemetry layer.                                                                                                                                                                                                             |
| **Driver calls that take no timeout can hang** (BR-M1-02, BR-M1-04) | `ElementHandle.click`, `evaluate`, `dispose` and `page.close` have no timeout parameter, and under load they can wait forever on an execution context that is going away. The adapter enforces its own budget on all of them; bounding only the one that hangs first just moves the hang.                                                                                                                            |

## Deviations from the plan as written

| Deviation                                                         | Reason                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §31's full package tree is **not** scaffolded up front            | Only packages with an active story are created; `scripts/new-package.mjs` adds the rest in one command. 35 empty packages with placeholder tests asserting nothing is permanent noise, and contradicts "no half-finished implementations" |
| Fixtures live in `packages/fixtures`, not a top-level `fixtures/` | Matches where every other package lives and where the workspace globs already pointed. `test-utils` had already established that test-only code sits in `packages/` and is marked `private`                                               |
| `tests/*` are workspace packages                                  | `tests/golden` has real dependencies and is imported by later stories, so it needs a `package.json` like anything else. `tests/*` added to `pnpm-workspace.yaml`                                                                          |

### The orchestrator cannot live in `packages/core` (BR-M1-28)

The dev plan places the Scan Orchestrator in `packages/core`. §1.2 puts
`core` in the innermost layer, importing nothing from `browser/`,
`discovery/` or `collectors/` — and an orchestrator imports all three. It
lives in `packages/orchestrator`, a new layer above them and below
`apps/cli`. The interactive barrier assist (BR-M1-29b, planned for
`packages/browser/manager`) moved for the same reason: it needs the barrier
taxonomy from `collectors/network`, which the browser manager must not
depend on.

### Reopening a session directory silently destroyed the event log's order

Measured, not reasoned about. Constructing a second `EventStore` over an
existing session directory reopened segment 1, appended into the middle of
it, and rewrote the manifest with only the new run's ranges. An 18-event log
written across two runs read back as `1,2,13,3,4,14,…` — every event still
present, the order destroyed, no error anywhere.

A test asserting "appends to an existing session rather than truncating it"
had passed since BR-M0-09. It wrote three events, which all fit in segment 1,
so it only ever covered the case that worked.

Continuing a session is now explicit (`resume: true`), opening a store
without it over an existing session throws, and a resume opens a _new_
segment rather than appending to the last one — the previous run may have
died mid-line, and appending after a torn line splices two events into one
unparseable record.

### The discovery deadline has to bound the join, not just the loop

§8.5 rule 2's bound was implemented as a race in the browsing loop, and every
test passed with it removed — because every test's discovery source honoured
its abort signal. One that does not (a subprocess wrapper that never wired
the signal through) would hang the scan at the _join_, after every page had
been visited and with every artifact still unwritten. Both the loop's wait
and the join are now time-boxed, and a source that will not stop is recorded
as a degradation rather than waited on.

### What is stable across runs, and what is not (BR-M1-31)

Measured across three consecutive scans of the same fixture:

- **Identical:** the number of events (63), the event-type histogram, the
  exported attack surface, and the report — byte for byte after masking the
  ephemeral port, the session path and the duration.
- **Not identical:** the _interleaving_ of the first few events. Chrome
  reports its startup targets in a nondeterministic order, so a given
  request can land on a different envelope sequence from one run to the
  next.

The consequence is that `source_event_ids` may differ between runs for the
same request, while always resolving correctly inside the run that produced
them. The M1 gate therefore asserts the two things that are actually true —
the event log's _content_ is stable, and every cited id resolves in its own
log — rather than masking the ids and calling the result "deterministic".

### The exported model must not carry CDP handles

Exporting the network collector's model directly put Chrome's `requestId`
and `frameId` into `attack-surface.json`. Three runs of the same scan
produced three different documents, and the handles are unresolvable outside
the CDP session that issued them: a consumer cannot look one up and a
reviewer cannot diff one. The exporter now maps observations onto
`ExportedApi` with deterministic `api_NNNN` ids and `source_event_ids` that
point into `events.jsonl`, and validates the document against its own schema
before writing it.

### A sitemap can name any host, so discovery must check before it fetches

A sitemap index lists other sitemaps, and those URLs come from the target's
response. Browser-native discovery fetched them unchecked, which is a
request the user never authorized, made from their machine, at a URL the
target chose — reachable at `169.254.169.254` or anything on the operator's
network. The policy check is now required rather than optional on that port,
and `robots.txt` itself is checked too.

### A scan reported success for a site it never opened

Found by the gate, not by review. With loopback denied (the default) every
URL was refused by the adapter, the runner returned `{discovered: [],
requests: 0}`, and the orchestrator counted a visited page: the scan printed
"complete · 1 of 1 discovered", wrote artifacts and exited 0.

Three causes, all fixed: the runner swallowed a policy denial as an empty
success; `VisitResult` had no way to say "not loaded"; and the queue used a
hand-rolled scope check that accepted a URL the adapter then refused. The
queue and the adapter now share one `PolicyEngine`, a visit reports its
outcome explicitly, and a browsing phase that loaded nothing is a failure
with a remedy naming the setting that caused it.

### A V8 heap ceiling does not bound a native parser (BR-M2-09)

§10B.9 asks for bounded workers. One was built with
`resourceLimits.maxOldGenerationSizeMb` and removed after measurement: a 16 MB
ceiling parsed a 4.8 MB bundle to completion while resident memory grew
342 MB and the JS heap grew 0.0 MB. tree-sitter allocates its syntax tree in
native memory, which V8's limit does not govern.

Worse, hitting the ceiling was not clean — worker threads share the process
address space, and under a pooled test runner a nested worker reaching its
limit took the host process down three times out of three.

The size gate is the memory bound: RSS tracks input size at roughly 28x, so
capping input caps memory. Together with the per-file time budget and a parser
that returns partial trees instead of throwing, §10B.9's requirement is met by
a different mechanism than the one it names. Recorded in full in
`js-analysis-spike.md`.

The general lesson, which is why this is here rather than only in the spike
note: a bound expressed in the wrong units is not a weak bound, it is no
bound. It would have passed review and shown green tests while protecting
nothing.
