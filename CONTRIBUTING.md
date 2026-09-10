# Contributing to BrowserRecon

## Issues are very welcome

Bug reports, feature ideas, questions, and especially **false-positive reports**
(a workflow detected that isn't real, a gap reason that's wrong) are the most
useful thing you can contribute. Workflow detection is tuned against real
applications, and reports from real applications are how it improves.

## Pull requests are by prior discussion only

Please open an issue before writing code. Unsolicited pull requests may be
closed without detailed review.

This is not a judgement of your work — it reflects the maintenance model. Two
honest reasons:

1. **BrowserRecon handles credentials, TOTP secrets, and unredacted captured
   application data.** Its users point it at sensitive environments. That makes
   it a supply-chain target, and a change merged without a thorough audit is a
   risk transferred directly to those users.
2. **It is maintained by one person** who would rather decline a good change
   than merge one they cannot fully verify.

If we agree on an approach in an issue, we'll discuss a PR. Frequently the
faster path is: you describe the improvement, and it gets implemented directly.

## If you're reporting something

Useful reports include the BrowserRecon version, the command you ran, your
policy/profile settings, and what you expected versus what happened.

**Please redact before posting.** `.output/` deliberately contains raw
unredacted data — cookies, tokens, authorization headers, request bodies. Never
paste it into a public issue. `report.md` is redacted by default and is usually
the safe thing to share.

For anything security-sensitive about BrowserRecon itself, use
[SECURITY.md](SECURITY.md) instead of a public issue.

## Development

```bash
corepack pnpm install
corepack pnpm verify      # run this before every push
```

Requires Node >= 22. `pnpm` is pinned via `packageManager`; corepack provides
it, so no global install is needed.

## If you do end up writing code

A few conventions that are enforced rather than suggested:

- **Package boundaries.** Import from a package root, never deep into its
  `src/`. ESLint fails the build on deep imports.
- **Only `packages/config` reads `process.env`.** Everything else receives
  configuration by injection, so there is exactly one place the environment
  enters the system.
- **Deterministic IDs.** Never random UUIDs — golden-output tests cannot assert
  against random values.
- **Thresholds are configuration.** No timing window, size limit, or confidence
  floor as a literal buried in a function.
- **Provenance travels with data.** Any function producing a derived or
  inferred value sets `provenance` where the value is created, not at export.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`).
- **No new dependencies without discussion.** CI enforces a license allowlist,
  and every added dependency widens the supply-chain surface.

## Two things that will never be accepted

- Anything that bypasses or defeats a security control — CAPTCHA solving, WAF
  evasion, bot-detection circumvention, authentication or MFA bypass. Barriers
  are recorded, never circumvented.
- Active exploitation or destructive testing. BrowserRecon produces hypotheses
  for other tools to validate; it does not attack.

## License

Contributions are accepted under [Apache-2.0](LICENSE), the project's license
(inbound = outbound). There is no CLA, and contributors retain copyright in
their own contributions.
