# Security policy

## Reporting a vulnerability in BrowserRecon

Please **do not open a public issue** for a security problem in BrowserRecon
itself.

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability), which keeps the report private until a fix
is available.

What's useful in a report: what you found, how to reproduce it, and what an
attacker could achieve. A proof of concept helps but is not required.

Expect an acknowledgment within a week. This is a single-maintainer project, so
please be patient with fix timelines — you'll be kept informed rather than left
guessing, and credited in the advisory unless you'd rather not be.

## What counts as a vulnerability here

BrowserRecon runs against sensitive environments with real credentials, so the
issues that matter most are about **containment**:

- Credentials, tokens or captured data leaving the machine, or reaching a log,
  export, report or model prompt that should have been redacted
- The tool exceeding its Target Policy — scanning an out-of-scope origin,
  issuing a method the policy forbids, or ignoring rate limits
- The AI Explorer performing an action the Policy Engine should have denied
- Any code path that bypasses a security control on the target (CAPTCHA, WAF,
  bot detection, authentication) — this is prohibited by design, so its
  presence is a defect
- Supply-chain problems: a compromised dependency, or a build/release integrity
  issue

## What is intentional, not a vulnerability

- **`.output/` contains unredacted data.** The event store is deliberately raw
  and local-only; it is the evidence base that correlation depends on.
  Redaction applies at the boundaries that leave the machine — reports,
  exports, and model prompts. See [§37.2 in the spec map](docs/architecture/spec-map.md) for what that
  section requires.
- **The tool sends requests to the target you point it at.** That is its
  function. Scanning without authorization is a misuse problem, not a tool
  defect.
- **Findings are hypotheses, not confirmed vulnerabilities.** Unverified
  security hypotheses in the output are by design; BrowserRecon does not
  validate exploitability.

## Reporting misuse

If you believe BrowserRecon is being used against systems without
authorization, that is a matter for the operator and their target, not
something this project can act on. The tool requires an explicit authorization
acknowledgment and records it in each scan session.
