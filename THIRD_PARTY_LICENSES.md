# Third-party licenses

BrowserRecon is licensed under Apache-2.0. Components listed here retain their
own licenses and copyright notices.

The distinction that matters is **bundled vs. invoked**: a component shipped
inside our distribution carries attribution obligations, while a program the
user installs themselves and we merely execute does not. Both are recorded here
regardless, because users of a security tool deserve to know its full
dependency surface.

## Bundled — shipped inside the distribution

Attribution required. Verified at the pinned versions.

| Component                  | License    | Role                                     |
| -------------------------- | ---------- | ---------------------------------------- |
| yaml (`yaml@2`)            | ISC        | Runtime — parses YAML config (§7.2, §11) |
| commander (`commander@15`) | MIT        | Runtime — CLI argument parsing (§30)     |
| TypeScript                 | Apache-2.0 | Build toolchain                          |
| ESLint                     | MIT        | Lint toolchain                           |
| Prettier                   | MIT        | Format toolchain                         |
| Vitest                     | MIT        | Test runner                              |

_Runtime dependencies are added to this table by the story that introduces
them. Still expected per the build plan: Puppeteer (Apache-2.0), tree-sitter
and tree-sitter-javascript (MIT), and — from V5 — chrome-devtools-mcp
(Apache-2.0)._

## Invoked — external, user-installed, never bundled

No attribution obligation, credited as good practice.

| Component                 | License    | Role                                                                                |
| ------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| Katana (ProjectDiscovery) | MIT        | Optional breadth discovery (build plan §10D.1)                                      |
| Ollama                    | MIT        | Optional local AI runtime (§25)                                                     |
| Qwen3 models              | Apache-2.0 | Optional local models, pulled by the user (§25.5)                                   |
| jsluice (Bishop Fox)      | MIT        | Optional secondary JS analyzer; also the reference for extraction approach (§10A.1) |

## Browser components

The Docker image ships **Chromium or Chrome for Testing, never branded Google
Chrome** — Chromium is open source (BSD-3-Clause plus assorted licenses for its
bundled components) and redistributable with notices, whereas Google Chrome is
proprietary under Google's Terms of Service and must not be redistributed. The
exact browser build and its licenses are recorded here when the image is
introduced (dev plan BR-M7-06).

## Verification

CI enforces a license allowlist (`MIT`, `Apache-2.0`, `BSD-2-Clause`,
`BSD-3-Clause`, `ISC`) across all dependencies including transitive ones, so a
component outside that set cannot enter the tree without failing the build.

|               |                                      |
| ------------- | ------------------------------------ |
| Last verified | 2026-09-10                           |
| Verified by   | initial scaffold (dev plan BR-M0-01) |
