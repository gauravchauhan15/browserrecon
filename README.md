# BrowserRecon

> **Pre-release — not yet functional.** This repository is being built story by
> story from a written plan. Nothing here is usable yet; there is no release to
> install. Follow the issues to track progress.

Browser runtime recon — captures how an application actually behaves in a real
browser and turns it into a structured attack-surface model for DAST, API
scanners and CI pipelines. Cross-workflow relationships, multi-step API
sequences, state transitions and JS-mined endpoints. Local-first, no telemetry.

---

## Authorized use only

BrowserRecon drives a real browser against a live application, submits forms,
and can be given credentials. **Only run it against systems you own or have
written authorization to test.** The tool requires an explicit authorization
acknowledgment before its first scan, and records that acknowledgment in the
scan session.

It does not, and will not, attempt to bypass authentication, CAPTCHAs, WAF
challenges or bot-detection controls. Barriers are recorded as reconnaissance
data, never circumvented.

## What it is

BrowserRecon is an Agentic Application Attack Surface layer that maps: Agent → Page → WebMCP/Tool → API → Workflow → State → Business Action

The idea is to bring application-layer intelligence from browser/runtime signals — including AI surfaces, WebMCP tools, agent-accessible APIs, high-impact actions, workflow/state dependencies, and paths such as:

Web content → Agent context → Tool/Action → External side effect

It observes a live Chrome session at the protocol level and correlates what it
sees into an application model:

- **Workflows** — reconstructed multi-step journeys with their boundaries and confidence
- **API sequences** — ordered, with `caused_by` / `depends_on` relationships
- **State transitions** — the application state graph a workflow moves through
- **Initiator chains** — interaction → script → request → response → next request
- **JS-mined candidates** — endpoints and routes extracted from JavaScript, marked as candidates until runtime confirms them
- **Coverage accounting** — what was observed, what was not, and _why_, with a typed reason for every gap

## What it is not

Not a vulnerability scanner, not a WAF, not an exploit engine, and not an
autonomous pentesting tool. It produces **hypotheses and evidence** for other
tools to act on — never confirmed findings. Active exploit validation is
explicitly out of scope.

## Provenance discipline

Every output field records where it came from: `observed`, `imported`,
`correlated`, `derived`, `inferred`, `static_context_inferred`, or
`hypothesis`. Observed facts and AI inference are never blurred, and a consumer
can filter inference out entirely and still get a self-consistent,
runtime-grounded result.

## Planned usage

```bash
# Tier 0 — no external tools, no AI
browserrecon scan https://example.com

# Tier 1 — plus broader discovery from any crawler
katana -u https://example.com -silent | browserrecon scan https://example.com --import-urls -

# Tier 2 — plus local AI interpretation
browserrecon scan https://example.com --ai

# Full pipeline: AI-guided exploration and cross-workflow reasoning
browserrecon agent https://example.com
```

`scan` observes and analyses, and can never cause a browser action of its own
choosing. `agent` decides, explores and analyses.

## Local-first

No account, no API key, no cloud service, and no telemetry. The target
application's data, the browser session, credentials and any AI inference all
stay on the machine running the scan. CI enforces this with a network-egress
test asserting the tool contacts nothing but the target and localhost.

## Development

```bash
corepack pnpm install
corepack pnpm verify      # typecheck + lint + format + test + secret scan
```

Requires Node >= 22. `pnpm` is pinned via `packageManager` and provided by
corepack, so no global install is needed.

Why the architecture looks the way it does — and what has been deliberately
ruled out — is recorded in
[docs/architecture/decisions.md](docs/architecture/decisions.md).

## Contributing

Issues, bug reports and ideas are very welcome. **Pull requests are currently
by prior discussion only** — please open an issue first. See
[CONTRIBUTING.md](CONTRIBUTING.md) for why.

## License

[Apache-2.0](LICENSE). Third-party components retain their own licenses; see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
