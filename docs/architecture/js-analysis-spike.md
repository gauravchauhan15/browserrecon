# JS analysis parser spike — BR-M2-05

§10A.1 nominates tree-sitter (following jsluice). BR-M2-05 requires that to be
_proven_, not assumed: "tree-sitter in Node parses a large real-world minified
bundle within §10B.9's bounds", measured on a ≥5 MB bundle.

Measured, rather than reasoned about. The alternative considered was **acorn**
— pure JavaScript, 568 KB installed, no native component — which would have
been the cheaper dependency if it held up.

## Method

7.29 MiB of genuinely minified production JavaScript: Prettier 3.9.6's `flow`,
`typescript`, `babel` and `estree` plugin bundles (1.1 MB, 0.9 MB, 0.3 MB,
0.2 MB — each one real, each one shipped minified), each wrapped in its own
IIFE so the concatenation is valid JavaScript rather than a syntax accident,
repeated three times to pass the 5 MB threshold.

Node 24, macOS arm64, `--expose-gc`, heap sampled around a forced collection.

## Result

|                                    |       time |   heap Δ |    RSS Δ |
| ---------------------------------- | ---------: | -------: | -------: |
| tree-sitter, parse only            |     351 ms |   +7 MiB | +207 MiB |
| **tree-sitter, parse + full walk** | **727 ms** |   +1 MiB | +204 MiB |
| acorn, parse only                  |     276 ms | +120 MiB | +236 MiB |

The walk is the honest number: extraction visits every node, and it found
50,838 string literals and 66,378 call expressions in that 7.29 MiB.

Both parsers are comfortably inside any sane per-file budget. A _typical_
first-party bundle is 1–2 MB, which extrapolates to roughly 100–200 ms.

**RSS grows to about 28× the source size.** That is the number that matters
for §10B.9: a 20 MB bundle would want ~560 MB. It is the argument for the
maximum-asset-size cap and the bounded worker, not a reason to reject the
parser.

## Why tree-sitter, given acorn is smaller and comparably fast

Error tolerance, and one category of it in particular.

| input                                                 | acorn      | tree-sitter  |
| ----------------------------------------------------- | ---------- | ------------ |
| valid modern (top-level await)                        | ok         | ok           |
| **truncated mid-expression**                          | **throws** | partial tree |
| **truncated mid-function**                            | **throws** | partial tree |
| decorators (stage 3)                                  | throws     | ok           |
| JSX (unbuilt source)                                  | throws     | ok           |
| TypeScript syntax                                     | throws     | partial tree |
| Flow annotations                                      | throws     | partial tree |
| HTML comment in script                                | throws     | ok           |
| unicode escapes, hashbang, import assertions, `using` | ok         | ok           |

acorn throws on 6 of 12; tree-sitter returns a usable tree for all 12.

The deciding row is **truncated input**, because truncation is not an edge
case here — it is a normal outcome. §41's body-capture limits mean a large
bundle may be captured only in part, and a response can be cut off. A parser
that throws on a truncated bundle extracts _nothing_ from it; tree-sitter
extracts everything up to the break. Losing every endpoint in a partially
captured bundle, silently, is exactly the failure §10B.9 exists to prevent.

The second row that matters is unbuilt source: once source maps land
(BR-M2-17), the interesting file is original TypeScript or JSX, which acorn
cannot read at all.

## Install cost, which was the real worry

`tree-sitter` is a native addon, and a native addon that compiles on install
would be the same mistake as depending on `puppeteer` instead of
`puppeteer-core` (§25.2).

It does not compile. Both packages ship prebuilt binaries via
`node-gyp-build` for `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, `win32-arm64` and `win32-x64` — every platform this tool
targets. `node-gyp` is the fallback for an exotic platform, not the path.

- `tree-sitter` 0.25.1 — MIT — 4.4 MB installed (~0.55 MB per prebuild)
- `tree-sitter-javascript` 0.25.0 — MIT — 6.3 MB installed

10.7 MB total, both licenses already on the allowlist.

## Decision

**tree-sitter.** §1.1's fallback is not taken.

The parser stays behind the BrowserRecon-owned `JSAnalyzer` interface (§10A.1)
regardless — no tree-sitter type appears in any exported signature — so this
decision is reversible without touching a consumer.

## What this spike does _not_ establish

- Nothing was measured on Windows or Linux; the prebuild list is a claim from
  the packages, and CI runs Linux only.
- The 28× memory ratio came from one bundle shape. A bundle that is mostly one
  enormous string literal would behave differently.
- Extraction _quality_ is untested here. This measures that the parser copes;
  whether the rules find the right endpoints is BR-M2-06 and BR-M2-07.

---

# Follow-up: the worker was built, measured, and removed (BR-M2-09)

§10B.9 asks for deep parsing to run "in bounded workers/processes so malformed
or enormous bundles cannot take down the entire scan". A `worker_threads`
implementation with `resourceLimits.maxOldGenerationSizeMb` was written and
then removed. Two measurements.

## It did not bound the parser

A worker with a **16 MB** old-generation ceiling parsed a 4.8 MB bundle to
completion:

```text
ceiling 16MB -> PARSED. heap +0.0MB, rss +342MB, external +0.0MB
ceiling 64MB -> PARSED. heap +0.0MB, rss  -7MB,  external +0.0MB
```

tree-sitter allocates its syntax tree in **native** memory. V8's
old-generation limit never sees it, and `process.memoryUsage().external` does
not account for it either. The ceiling only ever bounded the JS side — the
source string and the result object.

The earlier run that _did_ report `memory_limit` was a 12 MB ceiling against a
4.8 MB source string: the string exhausted the JS heap. That is a real bound,
and it is not the bound the worker was there for.

## Hitting the ceiling was not clean

Worker threads share the process address space. Under a pooled test runner, a
nested worker reaching its ceiling reliably took the host process down —
reproduced three times out of three, as `Worker exited unexpectedly`. Standalone
the parent survived, so this is not universal; it is enough to disqualify the
mechanism as a safety net, because the failure it produced is the failure it
existed to prevent.

## What replaces it

§10B.9's _intent_, by three bounds that were measured to work:

| bound                          | what it covers       | why it works                                                                        |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `maxAssetBytes` (8 MB default) | enormous bundles     | the only thing that bounds native allocation, because RSS tracks input size at ~28x |
| per-file time budget           | pathological bundles | checked inside the walk, so partial findings survive                                |
| a parser that does not throw   | malformed bundles    | tree-sitter returns a partial tree; the analyzer catches the rest                   |

**This is a deviation from §10B.9's stated mechanism, not from its
requirement.** It is recorded here because the mechanism the plan named would
have looked correct in review and in a green test suite, and would not have
protected anything.
