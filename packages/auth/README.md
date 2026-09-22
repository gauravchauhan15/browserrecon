# @browserrecon/auth

Authentication profiles, TOTP, session-state tracking and test data profiles.

Distinct from `@browserrecon/authorization`, which answers _am I permitted to
scan this target_ (§7.4). This answers _log in as this user_, with credentials
the user supplied for an account they control.

## Owns

- **Auth profiles** (§12.1) — parsing, validation, and resolving the named
  environment variables.
- **TOTP** (§12.2) — RFC 6238, checked against the published test vectors.
- **Session state during a scan** (§12.3) — continuous verification, typed
  transitions, bounded re-authentication, and the `auth_context` every event
  is stamped with.
- **Test data profiles** (§12.5) — field-match rules for surface gated by
  input validation rather than authorization.

## Does not own

- **Driving the browser.** It decides _what_ to type and _whether the session
  is still good_; the adapter does the typing, under policy.
- **Whether the scan is authorized at all.** That is §7.4 and
  `@browserrecon/authorization`.

## Two rules, enforced rather than documented

**Secrets come from the environment, and the types have nowhere else to put
one.** There is no `password` field — only `passwordEnv`, which names a
variable. A profile with an inline secret does not parse, at any nesting
depth, and the error never echoes the value. A command line ends up in shell
history, in `ps` output, and in CI logs; a YAML file with a password in it
ends up in git. Neither is hypothetical.

**There is no bypass, and no code path towards one.** §12.2's table ends with
`MFA bypass — Never — Not supported`. What exists here is TOTP _generation_
from a secret the user handed over for their own test account — the same thing
their authenticator app does. What does not exist is anything that attempts a
factor we do not have the key to: no guessing, no window scan, no replay.
`tests/meta/no-solver.test.ts` scans the repository for it.

## The failure §12.3 exists to prevent

A 30-minute scan against an application with a 15-minute idle timeout silently
falls back to unauthenticated crawling halfway through — and every coverage
number after that point is wrong _while still looking authoritative_. A report
saying `/admin/users` returned 302 reads as "properly protected" when it means
"we were logged out".

So a lost session is a typed transition with the signal that found it, the
envelope sequence where coverage changed, and a `degradedAt` marker past which
nothing may be presented as authenticated. `auth_context` reverts to
`anonymous` the moment the session goes, because an observation made after a
logout must not carry a label saying it was made as that user.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
