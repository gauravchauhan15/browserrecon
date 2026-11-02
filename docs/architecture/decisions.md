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

### A signal string is not a check (BR-M3-12)

§17A's `application_api` verdict has carried the signal "first-party request
with an application payload" since it was written. Nothing checked the
payload. A scan of a six-page fixture reported ten APIs: six were the HTML
pages themselves, a seventh a 404 favicon.

Three variations of the same mistake were found in one afternoon at the M3
gate, and they are recorded together because the pattern matters more than any
one of them:

- The `application_api` signal described a check that did not exist.
- §17A.2's polling rule needs an interval; the model passed a repeat count and
  no interval, so the rule's first line returned false on every request ever
  classified. Its unit tests pass because they hand the classifier an interval
  directly.
- `AUTH_PATHS` matches a substring, so a vendor's `session-replay.js` was
  reported as the application's own authentication infrastructure.

All three were invisible to 1721 passing tests, because in each case both
sides of the seam were internally consistent and tested against their own
idea of the payload. The general lesson: **a rule's unit test proves the rule,
not that anything reaches it.** A guarantee is only real once something has
run it end to end on data it did not construct.

### Narrowing a rule once is not enough (BR-M3-12)

§18.1 says to merge adjacent workflow segments that "share an initiator
chain". Read as the same script _file_, that merges every segment of a
single-bundle application into one candidate — §18.1's own "one giant SPA
workflow" failure mode, produced by the step meant to prevent it. The rule was
narrowed to the top _frame_.

It shares a top frame too, as soon as it has an `api.get()` wrapper. That is
most applications. The same failure returned one level down, and the M3 gate
found it: five screens, five soft navigations, one candidate.

The comparison is now the whole chain, which is what the plan's words say. The
lesson is about the first fix rather than the second: narrowing from "the
file" to "the top frame" felt like the fix because it made the failing case
pass. It addressed one instance of "the shared prefix is not the call site",
not the class.

### Three flakes, one mistake (BR-M3-12, release prep)

Preparing the repository for public release surfaced three failing-at-random
tests in a week. They look unrelated and are the same error:

- `spike.bench.test.ts` bounded tree-sitter at ten seconds of **wall clock**.
  It failed at 50.5 s in the full suite and passed at 3.6 s alone, on one
  laptop, on one commit — the suite runs several headless Chromes beside it.
- `realtime-domain.test.ts` waited a fixed `drain(600)` for a browser to
  complete a WebSocket exchange, then asserted. Fine idle, not fine under load.
- `spike.bench.test.ts` again, bounding **RSS growth** at 100× the source size.
  Failed in CI at 106×.

Each asserted a number derived from the environment as though it measured the
code. The fixes differ because the right answer differs: the first measures CPU
time, which is the parser's own cost; the second waits for the exchange's
terminal event instead of a duration; the third was **deleted**.

Deleting is the part worth recording. The obvious move was to loosen the bound
to 300×, and it would have been wrong. Measuring the identical parse four times
gives +81.5×, +30.3×, −27.9× and +26.4× — a parse during which resident memory
fell. Switching the assertion to `heapUsed` looked like the principled fix and
is not: with 1.5 million AST nodes deliberately retained, three runs reported
+82.4 MiB, −5.7 MiB and −3.0 MiB, because a collection inside the window makes
the delta negative whatever is held. The assertion passed with the regression
present.

**A test that passes when the defect is there is worse than no test**, because
it also costs CI time and teaches people to re-run until green. What actually
bounds memory is the maximum-asset-size gate, which is deterministic; disabling
it fails five tests. The spike measurement stays in `js-analysis-spike.md`,
labelled as the single sample it always was.

The general rule: before asserting on a measured number, measure it more than
once. If the samples do not agree, the assertion is about the machine.

### The fixture encoded my guess, and reality disagreed (§21)

The first real WebMCP site this tool was pointed at reported **zero tools**
while four sat in the page. The adapter read `tools` with `Array.isArray`; a
production registry exposes a `Map` keyed by tool name, whose values wrap the
descriptor under `item` alongside `execute` and `mcpHandle`, with the schema
present both as an object on the descriptor and as JSON text on the wrapper.
Four assumptions, all wrong, all mine.

The cause was not the code. It was that `webmcp-site.ts` encoded what I
guessed the shape would be when the spec was young, and then the adapter was
written to satisfy the fixture. A fixture derived from a guess tests the guess.

Three things changed:

- The adapter normalises `Map`, array, `Set` and keyed object; takes the name
  from the key when the descriptor has none; parses a schema whether it
  arrives as an object or as text; and captures `annotations`, which it had
  never read at all.
- A second fixture, `webmcp-map-site.ts`, reproduces the real shape. Both are
  scanned by the gate, because handling only the newer shape is the same
  mistake facing the other way.
- The silence is gone. A registry that is present but yields nothing is now
  reported (§45); before, it was indistinguishable from no registry, which is
  why four tools could vanish without a trace.

**`annotations` turned out to be the valuable part.** `readOnlyHint: false` or
`destructiveHint: true` is a page declaring it publishes a state-changing
operation to any agent that visits — exactly §7.2's "an exposed destructive
operation is something to report, never to try". The report now names those
tools in their own sentence rather than leaving them as a row in a table.

The general lesson, and the reason this sits beside the three-flakes note: a
test built on an assumption confirms the assumption. The spike measurements
and this fixture failed the same way — both looked like evidence and were
really a record of what someone expected.

### Three ways to lose an endpoint you already recorded (§10A, §17A, §45)

A scan of the reference application with `--max-pages 1` produced a report whose API
inventory read **None**, beside a coverage score of 0.95 and 115 JavaScript
assets all marked captured. The log held the endpoints. Three independent
mechanisms were discarding them, and each looked locally reasonable.

**An origin is not a site.** `classifyTraffic` matched first-party by exact
origin, so `data-search.apigw.example.com` — the application's own search
gateway — was classified as somebody else's property and dropped. Almost no
real application serves its pages and its APIs from the same origin. There is
now a same-site rule on the registrable domain, recorded in the verdict's
signal so the weaker basis is visible, and a `third_party_api` role so an
endpoint on a genuinely foreign host is reported rather than filed as
`unknown`. The role is deliberately not `application_api`: §17A.3's consumer
table keeps it out of workflow detection, API sequencing and the coverage
denominator, which is what makes it safe to report.

**A bucket keyed on the wrong half of the exchange.** The API model only ever
opened a bucket on a _response_. A request still in flight when the budget
ended was counted in `unanswered` and listed nowhere — so the one first-party
API call in that scan was invisible. The request is the evidence that the
application calls an endpoint; the response only adds a status and a shape.
Unanswered requests are now listed, narrowly: `fetch`/XHR only, first-party or
same-site only, because without a content type the payload rules cannot run
and anything wider would be guessing. The status column says `no response`.

The §18.1 control fixture then rejected the first version of that, and was
right to. `fetch(beacon)` with nothing awaiting it is cancelled the moment the
page navigates — which is what an analytics beacon _is_ — and in a model keyed
on responses that is indistinguishable from a call the budget cut off. The
first version admitted both and put `/vendor/collect` in the attack surface.

The log already tells them apart and the model was not reading it: a cancelled
request has a `network_failed` event, and a request the scan outlived has
nothing after it. `network_failed` now clears the pending entry, so only the
second kind is listed; both are still counted. The real log that prompted all
of this shows the same shape — its three `network_failed` events are all
`canceled: true` analytics beacons, and the API gateway call that went missing
has no failure event at all.

A related version of the same mistake was caught in between: the first
unanswered pass classified without §17A.2's repeat statistics, so an endpoint's
verdict depended on whether its last response won a race with the budget. The
statistics are measured over the whole log and are as available to an
unanswered request as to an answered one.

**A correct rule applied one step too far.** `literalOf` returns `undefined`
for a template literal containing `${`, on the grounds that an interpolation
is an expression and not a value. True — and it was also being used for
_candidate_ extraction, where the shape is the whole point and §10A.3 already
calls everything a candidate. Minification is what made this total rather than
partial: the call-site rules need a callee that reads like a request, and a
bundler renames the wrapper to `r`, so the bare literal is the only signal
left. 110 minified bundles yielded zero candidates. They now yield
`/api/v2/orders/{id}`, with a guard that a path of nothing but placeholders —
`/{slugLanguage}/{slug}`, how a site writes every content URL — is a route and
not an endpoint, unless it sat in a request position where the position is the
evidence.

Three different components, one shape of error: a rule that is right about the
question it was written for, applied to a question nobody re-asked. None of
them had a failing test, because every test was written from the same
assumption as the code. What caught all three was pointing the tool at an
application nobody on this project had modelled.

**And the whole static pass was never wired in.** `javascript-discovery` had
an analyzer, a triage ranking, a bounded pipeline and a static↔runtime
reconciler, each with tests, since M2. Nothing outside the package imported
any of it. The report's `static_api_candidate` column was filled from the
_queue's_ skip list — a number that had nothing to do with JavaScript — which
is why the gap was invisible: the column was populated, so it looked wired.

### The largest responses were invisible to everything (§22.2)

A user searched one of the scanned bundles by hand and found thirteen endpoint
paths the tool had not reported — including the array an Angular HTTP
interceptor matches against, which is as close to a declared endpoint list as
a minified bundle gets.

The detection rules were not the first problem. §22.2 externalizes an
oversized payload to a content-addressed file, and it moves the **whole**
payload, not just its body. So eight events — the eight largest responses of
the scan, `the main entry bundle` among them — reached every consumer as
`{$external, hash, bytes}`: no url, no mime type, no body. The static pass
read 113 small chunks and none of the files the application actually lives in,
and the API model never saw those responses either.

Nothing failed. A consumer reading `payload.body?.text` on a reference gets
`undefined`, which is indistinguishable from a response whose body was not
captured — a case that is normal and already handled. The growth-control
mechanism deleted the most interesting events from the analysis and every
layer treated the result as ordinary.

`readEvents` now takes `resolveExternal`, off by default so the streaming
reader keeps its memory bound, and on wherever payloads are analysed. A
missing body file leaves the reference in place and reports a problem rather
than ending the read.

With the bundles actually being read, two detection rules followed:

- **An API marker need not be the first segment.** `/search-api/v2/plan/` is a
  real endpoint, and anchoring the marker to the start of the path classified
  it as a page. The marker is matched as a delimited word, not a substring,
  because a bare test puts `/capital/` in the API inventory.
- **An array of paths where one is plainly an API is an endpoint table.** Most
  entries in a real table carry no marker — `/category/skeleton/`,
  `/you-may-also-like/`, `/onboarding/answers/` — and read one string at a
  time they are pages. Read as a list they are one table, and the array is as
  structural a signal as a call site. Narrow on purpose: two paths minimum, at
  least one an API on its own evidence, `low` confidence and a basis naming
  the array, because the evidence is the company a string keeps.

Twenty-five candidates where there had been none, thirteen of them the ones
read off the screen by hand.

### An endpoint is a path and a base, and the base is written separately

A second pass over the same bundle, prompted by a user reading it by hand,
found the form the application actually uses for nearly every call it makes:

    let x = `${this.r.getApiBaseUrl(`4.1`)}loyalty/status/`

and, for the interceptor's match lists, the same idea one statement apart:

    const o = [`login/email/otp/`, `orders/.+/`];
    return o.map(p => new RegExp(getApiBaseUrl(`4.2`) + p));

Nothing in the analyzer could see either. `PATH_SHAPED` requires a leading
slash, and these paths have none — the base supplies it. That requirement is
not wrong: without a base in view, "a string containing a slash" is
`text/html`, `utf-8`, every MIME type and half the minified noise in a
bundle. What was missing is the thing that makes a relative path legible,
which is the base it is concatenated with.

Three rules, each resting on the base being visible:

- **A template that begins with the base.** The author has said, in the
  string, that what follows hangs off the API base. Nothing is inferred and
  no variable followed, so this is `medium` rather than `low`. A template
  that merely _contains_ a base is not this: `/assets/${base}/x` is a path
  with something interpolated into it, and reordering the two would build a
  URL the code never builds.
- **An array linked to the base it is mapped over.** The array and the
  `getApiBaseUrl` call are two statements apart, so the link is made by name
  — find `<name>.map(` inside the enclosing function and read the base out of
  the callback. Local to one function and one variable: anything wider is a
  dataflow engine, anything narrower misses the only form this appears in.
- **A regex matcher reduced to the path it matches.**
  `orders/[0-9]+/tax-documents/` names an endpoint as precisely as a template
  literal does, and `templatePath` already had the vocabulary for it. A
  lookahead is an exclusion rather than a segment — reducing
  `payment(?!/payment-gateways-per-method)` to a hole invented
  `payment{param}` — and anything that will not reduce cleanly is skipped
  rather than half-reduced.

The version argument is kept and the origin is not. `getApiBaseUrl("4.2")`
says the endpoints under it are `/4.2/...`; what host that resolves to is a
runtime value, and §10A.5 forbids inventing it. A fabricated origin in an
endpoint inventory is the worst possible kind of wrong: it sends someone
looking for a URL that never existed.

25 candidates became 117, across five API versions and three base getters.

One guard here is belt and braces and is documented as such: the bail-out
when a regex will not fully reduce is unreachable for every pattern short of
`/orders/(a)$x/`, because the path-shape tests downstream reject the same
characters. It states the intent where the reduction gives up rather than
leaving that to a regex three functions away — but a probe that removes it
changes no behaviour, and saying so is better than implying it is load-bearing.

## A page that is not finished is not a page that is empty

Pointed at the reference application, the scan reported zero pages visited, no DOM, no
forms and — under "Agentic tools" — _"this page published no tools to
visiting agents."_ The site publishes five. Three separate decisions had to
line up for that sentence to be printed, and each was reasonable on its own.

**The navigation was discarded.** `page.goto(…, { waitUntil:
"domcontentloaded" })` threw at the 15s action budget. The document had
committed, 126 requests and 23 bundles were already in the log, and the page
was sitting in the browser — but a throw is a throw, so the runner recorded
the URL as failed and never harvested it. A navigation that runs out of time
with a document committed is a **slow page, not a failed one**; it is kept
and flagged `loadTimedOut`. The guard that keeps this honest is that the
browser's URL must have _changed during this attempt_: a navigation that
times out before committing leaves the previous page in the tab, and
accepting that would file one page's links, forms and tools under another's.

**The registry was read too early.** A tool registry is published by script,
and the scripts that publish one run late. Measured on the reference application, headless and
cold, from the start of navigation:

| time  | state                                                   |
| ----- | ------------------------------------------------------- |
| 15.3s | `navigator.modelContext` exists, holding **zero** tools |
| 23.2s | two tools                                               |
| 26.0s | all five                                                |

Two things follow. Registration is a trickle with gaps — 7.9s from the
registry appearing to its first tool — so "the count held still briefly"
means nothing: a 500ms stability window harvested two of the five. And a
registry's _existence_ says nothing about its contents; at 15.3s it was
there and empty, which is the state most likely to be read as "no tools" by
anything that checks once. So the harvest waits in the page for the count to
go **idle** rather than to pause, with separate budgets for "no registry"
and "no registry yet" — the same observation, distinguishable only by
waiting, and only one of them worth paying 15s for.

**The report asserted what it had not observed.** A registry never appears
in traffic, so the only evidence that a page publishes no tools is a page
that was read and found to publish none. With the browsing phase failed
outright there was no such evidence, and the section said it anyway. It now
needs `pagesRead > 0` to make the claim. The same rule one step along: a
tool list cut off by the budget reads exactly like a complete one, so the
harvest reports `webmcpStillFilling` and the runner says so.

The common thread is the one this file keeps recording: a rule that was
right about the question it was written for, applied to a question nobody
re-asked. "Timed out" meant "failed" because every page measured until then
was a fixture that loaded in milliseconds. "Read the registry" meant "read
it now" because every fixture registered its tools in the first tick — which
is also why no test could tell a harvest that waits from one that does not,
and why the fixture now registers late, in two batches, with a gap.

One process note, because it cost a false negative. The probe for the idle
window _passed_ the first time it was run — the fixture package resolves to
its build output, and the edit that made the fixture adversarial had not
been built. A probe run against a stale `dist` proves nothing. Build first.

## The clock is the budget, and pages are what it buys

A scan of the reference application reached one page, which was the operator's own
`--max-pages 1`. The question it prompted was the better one: what else
constrains a live scan, and is any of it reachable from the command line?

Most of it was not. The runner already accepted `settleMs`, `drainMs`,
`navigationTimeoutMs` and `maxInteractionsPerPage` — and the CLI passed none
of them, so four knobs existed in the type and nowhere else. Two were
measurably wrong for real applications: a **2-second** wait for the network
to go quiet on a site whose network never went quiet inside fourteen
seconds, and a **15-second** document budget against a page that took 24.6s
to reach `domcontentloaded` cold and headless.

Exposing them as four more flags would have been the obvious fix and the
wrong one. Nobody can choose a settle time; what an operator actually knows
is how long they are willing to wait in total. So the runtime budget is now
**120 minutes**, and the per-page waits are derived from it: the budget
tracker divides the time remaining by the pages remaining, and the runner
spends that share — 40% on the document, 25% on quiet, the rest left for the
harvest, the interactions and the drain.

It re-divides every page, which is what makes it self-correcting rather than
merely arithmetical: a run whose early pages were slow gives later ones
less, instead of spending at a rate it can no longer afford and being cut
off with its queue half-read. The clock is a cap and never a target — a
queue that empties in ten minutes finishes in ten minutes.

Both ends are clamped. The floor is 20s per page because the reference application needed 24.6s
to load and published its agentic tools at 26s; below that a page is not
being scanned quickly, it is being scanned pointlessly. The ceiling stops the
division from handing the last page of a budget the rest of the afternoon.
The navigation share is bracketed at 15–60s, which spans where peer tools
put it: Playwright defaults to 30s, Katana to 10s.

Two hours rather than one because the thing being bought is pages, and a
modern application costs far more per page than this file's estimate of 50
requests — the reference application spent 126 on one. An hour at a polite rate buys a sample,
and workflows and interactions are exactly what a sample misses.

### Depth was tracked for ordering and never used as a limit

`Candidate.depth` existed from the start and fed `compareCandidates` so
shallower pages went first. Ordering shapes a crawl without bounding it: on a
site with pagination or faceted search, a page budget can be entirely spent
at depth 20 of one listing while whole sections sit unvisited at depth 2.
Every comparable tool exposes a depth limit — Katana defaults to 3, ZAP's
AJAX Spider to 10 — and this had none at all.

Now `--max-depth`, defaulting to 3, with `0` meaning no limit. It is checked
after the identity checks and before scope, so a refused candidate does not
spend a policy decision, and it is recorded as `depth_exceeded` rather than
dropped. Deliberately **not** profile-driven: how hard to hit a target and
how far to wander from the seed are independent choices, and a profile
carrying a depth would mean `--rate-profile polite` quietly reshaped the
crawl as well as slowing it. That independence is expressed in the type —
`RateLimits = Omit<Limits, "maxDepth">` — rather than in a comment.

The first end-to-end run showed the other half of the problem. Depth worked,
and the four skipped URLs arrived in the report as `budget_exhausted`,
whose remedy is "raise the budget, or resume this session" — neither of
which reaches a URL that was never queued. A depth limit is not a budget
running out; it is the crawl being told how far to go and going that far.
`depth_limited` is its own reason now, with its own remedy.

One gap stated rather than papered over: the _arithmetic_ of the per-page
split is tested and probe-verified, but the **wiring** — that the runner
spends the allowance it is handed rather than ignoring it — is covered only
by types. A probe that makes `visit` discard `allowanceMs` entirely passes
the whole suite. The runner builds its adapter inside `launch`, so there is
nowhere to inject a fake one and assert what it was given; adding that seam
is a change to the runner's shape rather than its behaviour, and it did not
belong in this pass.
