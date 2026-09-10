# @browserrecon/config

Configuration loading, validation and precedence.

## Owns

- Reading YAML/JSON config files
- Applying environment and CLI overrides in a defined order
- Coercing and validating every value, with errors that name the field
- Recording **where each value came from**, so "why is my rate 5?" is answerable
- **The only place in the codebase that reads `process.env`** (dev plan §2.5)

## Does not own

- **Target Policy semantics** — allowed origins, methods, limits and agent
  permissions belong to `@browserrecon/policy` (build plan §7). This package
  loads values; policy decides what they permit. Keeping them apart means a
  change to a convenience setting can never quietly widen a scope restriction.
- **CLI argument parsing** — `apps/cli` parses argv and hands this package the
  already-parsed flags.

## Precedence

```
CLI flag  >  environment variable  >  config file  >  declared default
```

Each level is more specific to _this run_ than the one below it: a file
describes a project, an environment variable describes a machine or pipeline,
and a flag describes one invocation.

## Why `process.env` is confined here

Configuration is injected everywhere else, which means tests need no
environment mutation, a value's origin is always traceable, and there is
exactly one place to audit when asking what this tool reads from its host.
ESLint enforces it.

## Coercion is deliberately strict

Environment variables and CLI flags arrive as strings, so coercion is
unavoidable — but `"yes"` is not a boolean and `" 2"` is not silently trimmed
into a number. A mistyped rate limit should fail loudly rather than resolve to
something plausible.

Validation collects **every** problem in one pass, so a config file is fixed
once rather than re-running the command to discover each successive error.

Values from credential-shaped fields are redacted from error messages, so a
malformed password produces a useful error rather than printing the password
into a terminal or CI log (build plan §37.2).

## Settings

Generated from `CONFIG_SPEC` — a test fails if this table drifts from the code.

<!-- BEGIN GENERATED DEFAULTS -->

| Setting                             | Default           | Env                         | Flag               | Allowed                                | Description                                                       |
| ----------------------------------- | ----------------- | --------------------------- | ------------------ | -------------------------------------- | ----------------------------------------------------------------- |
| `target.origin`                     | _(unset)_         |                             | `--target`         |                                        | Origin to scan. Normally given as the command's argument.         |
| `output.dir`                        | `.output`         | `BROWSERRECON_OUTPUT_DIR`   | `--out`            |                                        | Directory for scan artifacts. Contains UNREDACTED data (§37.2).   |
| `output.formats`                    | `json, jsonl, md` |                             | `--format`         | `json` `jsonl` `md`                    | Artifacts to write.                                               |
| `output.redact`                     | `true`            | `BROWSERRECON_REDACT`       |                    |                                        | Redact secrets in reports and exports. The event store stays raw. |
| `log.level`                         | `info`            | `BROWSERRECON_LOG_LEVEL`    | `--log-level`      | `silent` `error` `warn` `info` `debug` | Diagnostic verbosity. Distinct from the event log.                |
| `rate.profile`                      | `normal`          | `BROWSERRECON_RATE_PROFILE` | `--rate-profile`   | `polite` `normal` `aggressive`         | How hard to hit the target. This is the safety dial.              |
| `thoroughness.level`                | `normal`          |                             | `--thoroughness`   | `shallow` `normal` `deep`              | How completely to explore. Does not affect request rate.          |
| `thoroughness.instancesPerTemplate` | `3`               |                             |                    |                                        | Instances sampled per route template (§9.5.3).                    |
| `thoroughness.divergenceSampleCap`  | `10`              |                             |                    |                                        | Cap on extra sampling when instances diverge (§9.5.3).            |
| `browser.headless`                  | `true`            |                             | `--headless`       |                                        | Run Chrome headless. Headed is often less bot-detected (§10C.7).  |
| `browser.executablePath`            | _(unset)_         | `BROWSERRECON_CHROME_PATH`  |                    |                                        | Chrome/Chromium binary. Auto-detected when unset.                 |
| `discovery.katana`                  | `true`            |                             | `--katana`         |                                        | Use Katana when present on PATH. Never required (§10D.1).         |
| `discovery.importUrls`              | _(unset)_         |                             | `--import-urls`    |                                        | URL list from any crawler; "-" reads stdin (§10D.1).              |
| `discovery.robots`                  | `true`            |                             |                    |                                        | Read robots.txt as a discovery source and a rate floor (§8.3).    |
| `discovery.sitemap`                 | `true`            |                             |                    |                                        | Read sitemap.xml as a discovery source.                           |
| `discovery.probeLiveness`           | `false`           |                             | `--probe-liveness` |                                        | Probe unobserved candidates with HEAD/OPTIONS (§10C.7).           |
| `ai.enabled`                        | `false`           |                             | `--ai`             |                                        | Enable local AI interpretation (V4).                              |
| `ai.tier`                           | `standard`        |                             |                    | `small` `standard` `large`             | Model tier when no explicit model is given (§25.1).               |
| `ai.model`                          | _(unset)_         | `BROWSERRECON_AI_MODEL`     | `--model`          |                                        | Explicit model name. Overrides the tier.                          |
| `ai.endpoint`                       | _(unset)_         | `BROWSERRECON_AI_ENDPOINT`  | `--ai-endpoint`    |                                        | OpenAI-compatible base URL. Unset means local Ollama (§25.1).     |
| `session.resumeFrom`                | _(unset)_         |                             | `--resume-from`    |                                        | Session id to resume (§30).                                       |
| `session.seedFrom`                  | _(unset)_         |                             | `--seed-from`      |                                        | Session id whose candidate registry seeds a new scan (§30).       |

<!-- END GENERATED DEFAULTS -->

## Adding a setting

Declare it in `CONFIG_SPEC`. The precedence logic, validation, error messages
and the table above all follow from the declaration — there is no second place
to update. A threshold that is not declared here has nowhere legitimate to
live (dev plan §2.8).
