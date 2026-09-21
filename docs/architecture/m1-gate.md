# 🚦 M1 gate — V1: Deterministic Runtime Recon

Dev plan BR-M1-31; build plan "V1 is done when".

Executable at `tests/gate/src/m1.gate.test.ts`. This document says what was
proven and, more usefully, what was **not**.

## The claim

A clean machine points `browserrecon scan` at a URL, with no AI installed and
no crawler, and gets useful attack-surface output.

```bash
browserrecon scan https://shop.example.com --i-am-authorized
```

## Proven

| §44 clause                            | How                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------ |
| A clean machine can install the tool  | `pack` job in CI installs the tarball into an empty directory            |
| A target URL launches isolated Chrome | Per-scan profile, swept on exit; `manager.test.ts` asserts no orphan     |
| Runtime events are collected          | 63 events on a four-page fixture, from CDP, persisted as they arrive     |
| Network/API observations are stored   | `attack-surface.json` validates against its own schema before writing    |
| JSONL survives browser failure        | Monotonic, gapless log; bounded relaunch; export runs on partial data    |
| Final JSON and Markdown are generated | Both written, both non-trivial, report carries the §10C.6 caveat         |
| Scope controls work                   | Loopback denied by default; excluded paths never visited; no POST issued |
| Deterministic fixture tests pass      | Three consecutive runs produce byte-identical artifacts                  |

Plus BR-M1-31's own criteria: golden outputs stable across three runs, one
rate budget shared by discovery and browsing, no POST under the default
policy, and collected data surviving a browser failure.

## Not proven, and worth stating

- **Determinism is of the artifacts, not the event log's interleaving.**
  Across three runs the event count and type histogram are identical, and the
  exported model and report are byte-identical after masking the ephemeral
  port, session path and duration. The _order_ of Chrome's first few startup
  events is not stable, so a request can land on a different envelope
  sequence between runs. The gate asserts what holds — the log's content, and
  every cited event id resolving inside its own log — rather than masking it.
- **Fixtures only.** Nothing here has met a real site. Gate A (after V3) is
  where that happens, and it is deliberately human-run.
- **One browser, one platform.** Chrome on the CI runner and on the
  developer's machine. No Firefox, no Windows.
- **No authentication.** Every fixture is anonymous; auth profiles are M2.
- **Correlation is not exercised.** V1 records what happened; `caused_by`,
  `depends_on` and workflows are V2/V3, and the exporter emits empty arrays
  for them — present-but-empty, so a consumer can tell "not reported yet"
  from "none found".
- **`--seed-from` is implemented but unexercised end to end**, because it
  needs two sessions and the second one is a scan; the decision logic and
  the refusal are fully tested.

## What the gate found that unit tests did not

Recorded because it is the argument for having a gate at all:

1. A scan reported `complete · 1 of 1 discovered`, wrote artifacts and exited
   0 — against a site the browser never opened. Three causes, all fixed.
2. A page harvest was silently refused by a policy check that did not know
   the action's name, so a four-page site looked like a one-page site with no
   links.
3. Chrome's `requestId` and `frameId` were leaking into the published model,
   making every run a diff and giving consumers handles they cannot resolve.
4. Browser-native discovery fetched nested sitemap URLs — which come from the
   target's response — with no policy check.

Each is in `decisions.md` with what was measured.
