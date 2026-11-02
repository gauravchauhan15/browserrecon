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

The `limits` line also prints the crawl depth, which is not part of that
arithmetic: depth bounds the crawl's _shape_ rather than its size, and it is
deliberately not set by the rate profile, so asking to be gentle never
quietly reshapes the crawl as well as slowing it.

One asymmetry to know before you tune anything. For `--max-pages`, `--rps`,
`--concurrency` and `--timeout-minutes`, **`0` means "use the rate profile's
value"** — the profile table stays the single source of truth. For
`--max-depth`, **`0` means no limit at all**. Same literal, opposite meaning,
because depth has no profile to fall back to.

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
it.

`resume` is not finished in this build. It validates the session and then
says so rather than pretending — the §30 boundary check is real, and it will
tell you precisely which setting changed if you try to resume with a
different one. The engine behind it lands later, and `--seed-from` is not
wired either.

Until then, scan again with the limit that actually stopped it raised. Check
which one that was before reaching for `--max-pages`: on a real application
the page budget is rarely what binds first. The coverage table in `report.md`
names the reason per URL, and `depth_limited` — not `budget_exhausted` — is
the common one.

```bash
node apps/cli/bin/browserrecon.js scan https://your-target.example.com --max-depth 5 --out ~/browserrecon-runs
```

Each run gets its own `sess_NNNN` directory, so pointing every scan at the
same `--out` is fine — the runs sit side by side and diff cleanly.

---

## 4. The real run

Once the small scan looks sane:

```bash
node apps/cli/bin/browserrecon.js scan https://your-target.example.com --rate-profile normal --max-pages 60 --timeout-minutes 20 --out ~/browserrecon-runs
```

Useful additions, depending on the target:

| Flag                                    | When                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| `--max-depth 5`                         | Sections sit further from the seed than the default 3 reaches   |
| `--allowed-origins a.example,b.example` | The app spans more than one origin you are authorised for       |
| `--no-headless`                         | The target treats headless Chrome differently                   |
| `--thoroughness deep`                   | More exploration per page. Does **not** change the request rate |
| `--concurrency 2` / `--rps 1`           | The target is fragile, or you want to be gentler than `polite`  |
| `--no-katana`                           | Discovery is browser-native only, even if Katana is installed   |

### Flags that exist and do nothing yet

`scan --help` is generated from the configuration schema, so it lists settings
the engine has not been wired to. These parse, and are then ignored:

`--import-urls`, `--seed-from`, `--probe-liveness`, `--max-steps`, `--ai`,
`--model`, `--ai-endpoint`.

The AI flags are V4 and say so. The other three have implementations that
nothing calls yet. Do not read a result as evidence about any of them.

---

## 4a. Scanning signed in

Everything above runs as an anonymous visitor. To scan what is behind a login,
write a profile — **the file names environment variables and never holds a
secret**. A profile with a password in it does not parse (§12.1).

`profile.yaml`:

```yaml
name: customer
login:
  url: https://your-target.example.com/login
  # Omit the selectors unless the defaults miss. They cover
  # input[type=email] / input[type=password] / button[type=submit].
credentials:
  usernameEnv: BR_USER
  passwordEnv: BR_PASS
successCondition:
  # Pick ONE. A selector that exists only when signed in is the clearest.
  selectorPresent: "#account-menu"
  # urlContains: /dashboard
  # selectorAbsent: "#login-form"
```

Export the secrets, then scan:

```bash
export BR_USER='you@example.com' BR_PASS='your-password'
```

```bash
node apps/cli/bin/browserrecon.js scan https://your-target.example.com --i-am-authorized --auth-profile profile.yaml --max-pages 25 --out ~/browserrecon-runs
```

For OWASP Juice Shop, register an account in the UI first, then use
`selectorPresent: "#navbarAccount"` with `login.url` set to
`http://localhost:3000/#/login`.

**TOTP** is supported where you hold the secret: add `mfa: {type: totp,
secretEnv: BR_TOTP}`. Any other second factor is reported and not attempted —
§12.2 makes MFA bypass permanently out of scope, so a profile declaring one
fails with a message saying so rather than trying to work around it.

What to check in the result:

- The header says `Auth state | customer`, not `anonymous`.
- **Section 7, Access barriers, is empty.** A failed login appears there as an
  `authentication` barrier — if it is there, the scan described the anonymous
  surface of your application and the report says so rather than quietly
  reporting a smaller app.
- Pages that only exist signed in are in the inventory.

The scan submits the login form and nothing else. That exemption is scoped to
the origin of the login URL and closed as soon as the sign-in finishes;
everything else stays read-only, and forms are still reported and never
submitted.

---

## 5. What to look at, in order

Everything lands in `~/browserrecon-runs/sess_NNNN/`.

### `report.md` — read this first

Five sections, always in the same order, so two runs diff cleanly.

1. **Coverage summary** — the score, then the dimensions it was computed
   from. The score is capped below 1 by construction; it is a proportion of
   what the scan could reach, never of the application. A **Limits on this
   scan** line follows it wherever a coverage gap or an access barrier was
   recorded, naming the counts and the file that details them.
2. **Workflows** — candidates with the evidence that scored them. A
   low-confidence one is collapsed, never dropped.
3. **API inventory** — every endpoint, with its content type, whose host it
   is on, and §17A's role. Pages, scripts and images are _not_ here; they are
   in `attack-surface.json` with the role that excluded them. Under the table,
   **From JavaScript**: how many bundles were parsed, and the endpoints their
   code names that this scan never called.
4. **Agentic tools** — what the page publishes to any visiting agent, as a
   diagram of target → page → tool and a table beneath it. Reported, never
   invoked.
5. **Origins** — first-party, same-site and third-party, with request counts.

A sixth, **Security hypotheses**, appears only from V6.

The per-script JavaScript table, the barrier table, the gap table and the
artifact index are not report sections. They are in `attack-surface.json`,
which is where a machine reads them from: on a real target the script table
alone ran to 120 rows of cache-busted bundle names and pushed the findings
three screens down.

### `surface.json` — the model a scanner would consume

One item per thing on the surface: endpoints, agentic tools, origins. Each
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
