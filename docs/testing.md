# Testing BrowserRecon — the Gate A runbook

Gate A is the first time this tool is pointed at something that is not a
fixture. Everything before it was proven against eleven deterministic local
applications; what a real site exercises is the part no fixture can fake.

This is written to be followed in order. It takes about twenty minutes.

---

## 0. Before you start

**Only scan a system you own or have written permission to test.** The tool
refuses to start without an explicit acknowledgment and records that
acknowledgment in the session (§7.4).

It will not attempt to bypass authentication, a CAPTCHA, a WAF challenge or
bot detection. Barriers are recorded as reconnaissance data and never
circumvented (§7.3). If a scan stops at one, that is the correct outcome.

**The output directory holds unredacted captured data** — cookies, tokens,
`Authorization` headers and request bodies (§22.1, §37.2). Keep it out of git,
off cloud sync, and off tickets. Redaction applies at the boundaries that
leave your machine, not to the local event store, which is raw by design so a
scan can be re-analysed later with better rules.

---

## 1. Build and check the machine

```bash
cd ~/Projects/browserrecon && corepack pnpm install && corepack pnpm build
```

```bash
node apps/cli/bin/browserrecon.js doctor
```

`doctor` has to end with **Ready to scan**. Chrome is the only hard
requirement. Lines marked `--` are optional capabilities, and each one says
what it would add:

- **Katana** — breadth discovery. Without it, discovery is browser-native:
  DOM links, JS mining, `robots.txt`, `sitemap.xml`. Any crawler's URL list
  can be supplied instead with `--import-urls`.
- **Ollama and a local model** — only needed from V4. `--ai` does nothing yet.

---

## 2. See what a scan would do, before it does it

```bash
node apps/cli/bin/browserrecon.js config validate https://your-target.example.com
```

This resolves every setting, says where each non-default value came from, and
prints the boundary the scan would run inside: allowed origins, allowed
methods, excluded paths, the network rules, and the budget arithmetic.

Read the **effective** budget line. `max_pages` and `timeout_minutes` interact
with the rate profile, and the tool says which of them actually binds — a page
budget unreachable at the configured rate is called out explicitly.

Any setting that goes beyond a read-only scan is listed under **higher-risk**
in plain language. At the defaults there should be none.

---

## 3. The first scan

Start small. A first run is for finding out whether the tool and the target
get along, not for coverage.

```bash
node apps/cli/bin/browserrecon.js scan https://your-target.example.com --rate-profile polite --max-pages 10 --out ~/browserrecon-runs
```

At a terminal it will ask you to confirm authorization. In CI, or to skip the
prompt, add `--i-am-authorized`.

`--rate-profile polite` is the gentle setting and the right default for a
first contact with anything you do not own outright.

The default policy allows `GET`, `HEAD` and `OPTIONS` only. Nothing will be
submitted, posted, or deleted.

### If it stops early

That is usually correct, and the summary says which budget or policy stopped
it. To continue where it left off:

```bash
node apps/cli/bin/browserrecon.js resume sess_0001
```

---

## 4. The real run

Once the small scan looks sane:

```bash
node apps/cli/bin/browserrecon.js scan https://your-target.example.com --rate-profile normal --max-pages 60 --timeout-minutes 20 --out ~/browserrecon-runs
```

Useful additions, depending on the target:

| Flag                                    | When                                                               |
| --------------------------------------- | ------------------------------------------------------------------ |
| `--allowed-origins a.example,b.example` | The app spans more than one origin you are authorised for          |
| `--import-urls urls.txt`                | You already have a URL list from another crawler; `-` reads stdin  |
| `--no-headless`                         | The target treats headless Chrome differently                      |
| `--thoroughness deep`                   | More exploration per page. Does **not** change the request rate    |
| `--probe-liveness`                      | Send `HEAD`/`OPTIONS` to candidates found in JS but never observed |

---

## 5. What to look at, in order

Everything lands in `~/browserrecon-runs/sess_NNNN/`.

### `report.md` — read this first

Nine sections, always in the same order, so two runs diff cleanly.

1. **Coverage summary** — the score, then the dimensions it was computed
   from. The score is capped below 1 by construction; it is a proportion of
   what the scan could reach, never of the application.
2. **Workflows** — candidates with the evidence that scored them. A
   low-confidence one is collapsed, never dropped.
3. **API inventory** — application APIs. Pages, scripts and images are _not_
   here; they are in `attack-surface.json` with the role that excluded them.
4. **WebMCP tools** — what the page publishes to any visiting agent.
   Reported, never invoked.
5. **Origins** — first- and third-party, with request counts.
6. **JavaScript** — the bundles, their size, and whether a body was captured.
7. **Access barriers** — 401s, 403s, 429s, WAF and CAPTCHA challenges.
8. **Coverage gaps** — what was not reached, why, and what to do about it.
9. **Artifacts** — the files, with record counts.

### `surface.json` — the model a scanner would consume

One item per thing on the surface: endpoints, WebMCP tools, origins. Each
carries its workflow, the interaction that caused it, the state either side of
it, the identity that observed it, and `source_event_ids` that resolve in the
event log. The file validates against
`schemas/attack-surface/attack-surface.schema.json` and is checked against its
own contract before it is written.

### `attack-surface.json` — the full record

Every request the browser made, each with §17A's verdict, plus the workflows,
sequences, JavaScript and gap queue derived from them.

### `events-NNNN.jsonl` — the raw log

The ordering authority, and the thing every derived object traces back to.
Unredacted. Pick any `source_event_ids` from `surface.json` and find it here:

```bash
grep -m1 '"evt_000041"' ~/browserrecon-runs/sess_0001/events-0001.jsonl
```

---

## 6. How to tell whether it worked

Compare against [`docs/samples/`](samples/README.md), which holds real output
from real scans of fixture applications.

Signs it went **right**:

- The API inventory contains endpoints, and only endpoints.
- The coverage score is below 1, and the dimensions in the table add up to it.
- Third-party analytics appears under Origins and **not** in the API inventory
  or in any workflow.
- Every `source_event_ids` resolves in the event log.
- Coverage gaps has entries with reasons and remedies — an empty gaps section
  on a real site usually means the scan did not get far enough to find any.

Signs something is **wrong**, and worth reporting:

- Pages, scripts or images in the API inventory.
- A workflow whose steps are unrelated endpoints that merely happened nearby.
- A dependency between two requests that fired at the same time.
- Any number in `report.md` that disagrees with `surface.json`.
- Anything that reads as a claim of complete coverage.

---

## 7. What to send back

For a problem, the most useful thing is:

1. The exact command you ran.
2. `report.md` — read it first for anything you would not want shared.
3. The relevant section of `surface.json`.
4. **Not** `events-NNNN.jsonl` unless you have read it. It is unredacted.

A one-line description of what the target is (SPA, server-rendered,
authenticated, heavy on third parties) usually explains more than the files do.

---

## Running the test suite

```bash
corepack pnpm verify
```

Eight gates: typecheck, typecheck tests, lint, format, test, licenses,
schemas, and a secret scan of both the working tree and the history. All eight
have to pass before anything is pushed.

The milestone gates are the interesting part of the suite — they scan real
fixtures with a real browser and assert the properties each version claims:

```bash
corepack pnpm exec vitest run tests/gate
```

What each one proved, and what it did not, is written down in
[`docs/architecture/`](architecture/): `m1-gate.md`, `m2-gate.md`,
`m3-gate.md`.
