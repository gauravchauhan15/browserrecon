# BrowserRecon

Browser runtime reconnaissance. BrowserRecon drives a real Chrome against a
live application and turns what it observes into a structured attack-surface
model: the APIs an application actually calls, the workflows those calls form,
the state the application moves through, and the tools it publishes to AI
agents.

Local-first. No account, no API key, no cloud service, no telemetry.

> **Status: pre-release.** The deterministic engine (V1–V3) works end to end —
> `scan` drives a browser, correlates what it sees and writes a report. The AI
> layers (V4–V6) are not built, and the flags for them do nothing yet. See
> [Current status](#current-status).

---

## Authorized use only

BrowserRecon drives a real browser against a live application and can be given
credentials. **Only run it against systems you own or have written
authorization to test.** The tool requires an explicit authorization
acknowledgment before its first scan and records that acknowledgment in the
scan session.

It does not, and will not, attempt to bypass authentication, CAPTCHAs, WAF
challenges or bot-detection controls. Barriers are recorded as reconnaissance
data, never circumvented.

## Quickstart

Requires **Node >= 22** and **Google Chrome**. `pnpm` is pinned via
`packageManager` and provided by corepack, so no global install is needed.

```bash
git clone https://github.com/gauravchauhan15/browserrecon.git
cd browserrecon
corepack pnpm install
corepack pnpm build
```

Check the machine first — this must end with `Ready to scan`:

```bash
node apps/cli/bin/browserrecon.js doctor
```

See what a scan _would_ do, without touching the target:

```bash
node apps/cli/bin/browserrecon.js config validate https://example.com
```

Then scan:

```bash
node apps/cli/bin/browserrecon.js scan https://example.com \
  --i-am-authorized --rate-profile polite --max-pages 10 --out ~/browserrecon-runs
```

Results land in `~/browserrecon-runs/sess_NNNN/`. Start with `report.md`.

There is a step-by-step runbook in [docs/testing.md](docs/testing.md), and
real output from real scans — nothing hand-written — in
[docs/samples/](docs/samples/README.md).

## What it produces

A model of the application layer, assembled from runtime signals:

- **Workflows** — reconstructed multi-step journeys with their boundaries,
  the evidence that scored them, and a confidence value
- **API sequences** — ordered, with `caused_by` and `depends_on` relationships
- **State transitions** — the state graph a workflow moves through
- **Initiator chains** — interaction → script → request → response → next request
- **WebMCP tools** — the operations a page publishes to any visiting agent,
  reported and never invoked
- **JS-mined candidates** — endpoints extracted from JavaScript, marked as
  candidates until runtime confirms them
- **Coverage accounting** — what was observed, what was not, and _why_, with a
  typed reason and a remedy for every gap

The intent is an agent-era view of an application: Agent → Page →
WebMCP/Tool → API → Workflow → State → Business Action.

## What it is not

Not a vulnerability scanner, not a WAF, not an exploit engine, and not an
autonomous pentesting tool. It produces **hypotheses and evidence** for other
tools to act on — never confirmed findings. Active exploit validation is
explicitly out of scope.

## Design commitments

**Provenance on everything.** Every output field records where it came from:
`observed`, `imported`, `correlated`, `derived`, `inferred`,
`static_context_inferred` or `hypothesis`. Observed facts and AI inference are
never blurred; a consumer can filter inference out entirely and still get a
self-consistent, runtime-grounded result.

**Causality is never inferred from timing.** Two requests that happened to fire
together are not a chain. Relationships are graded — `direct`, `inferred`,
`temporal`, `sequence_candidate`, `dependency_candidate` — and every edge
states the basis a reader can check.

**No claim of complete coverage.** The coverage score is capped below 1 by
construction. It is a proportion of what the scan could reach under the policy,
session and budget in force — never of the application.

**Everything traces back.** Every derived object carries `source_event_ids`
that resolve in the raw event log. A derived object without resolvable source
IDs is a bug.

## Current status

| Version | What it covers                                         | State     |
| ------- | ------------------------------------------------------ | --------- |
| V1      | Browser scan, event store, discovery, reports          | Works     |
| V2      | API context, correlation, JS mining, sequences         | Works     |
| V3      | Workflows, state graph, coverage, attack-surface model | Works     |
| V4      | Local AI interpretation                                | Not built |
| V5      | AI-guided exploration (`agent`)                        | Not built |
| V6      | Cross-workflow reasoning                               | Not built |

`scan --help` is generated from the configuration schema, so it lists settings
the engine has not been wired to yet. These parse and are then ignored:
`--import-urls`, `--seed-from`, `--probe-liveness`, `--max-steps`, `--ai`,
`--model`, `--ai-endpoint`. `resume` validates a session and then reports that
the engine behind it is not built. `agent` is not implemented.

What each milestone gate proved — and, at more length, what it did not — is
written down in [docs/architecture/](docs/architecture/).

## Development

```bash
corepack pnpm verify
```

Eight gates: typecheck, typecheck tests, lint, format, test, licenses, schemas,
and a secret scan of both the working tree and the full history. All eight have
to pass before anything is pushed.

The milestone gates are the interesting part of the suite — they scan real
fixtures with a real browser and assert the properties each version claims:

```bash
corepack pnpm exec vitest run tests/gate
```

Why the architecture looks the way it does, and what has been deliberately
ruled out, is recorded in
[docs/architecture/decisions.md](docs/architecture/decisions.md). Source
comments cite section numbers (`§14`, `§18.1`) from the project's design
documents; [docs/architecture/spec-map.md](docs/architecture/spec-map.md)
explains the numbering and what the most-cited sections require.

## Contributing

Issues, bug reports and ideas are very welcome. **Pull requests are currently
by prior discussion only** — please open an issue first. See
[CONTRIBUTING.md](CONTRIBUTING.md) for why.

Security issues should not go in a public issue — see
[SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Third-party components retain their own licenses; see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
