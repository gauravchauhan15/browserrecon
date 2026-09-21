# @browserrecon/collector-interaction

Every action the explorer performs, recorded as an `interaction` event with a
stable element reference — so the requests that follow can be attributed to it.
Build plan §13.1, §14; dev plan BR-M1-08.

## Owns

- The recording wrapper around a `BrowserAdapter` (`collector.ts`).
- The selector strategy, and the rules for which ids are worth using
  (`element-ref.ts`).

## Does not own

- Deciding that an interaction _caused_ a request. That is §15's correlation,
  and §32.2 keeps it separate from collection. All this does is make the
  interaction exist, with an id, at a point in the event sequence — evidence
  correlation needs and cannot reconstruct afterwards.
- Choosing what to click — BR-M1-12's Deterministic Explorer.

## A wrapper, not a change to the adapter

`recordInteractions` implements `BrowserAdapter` and delegates to a real one.
The control boundary stays exactly what §5.1 defined — the adapter still does
nothing but drive the browser under policy — and recording is laid over it
rather than mixed into it. Callers hold the wrapper and cannot tell the
difference, so every action is recorded by construction rather than by each
call site remembering to.

Recording is **awaited**, not fired off. §32.9 asks that an event be durable
before it is considered processed, and this also means `model.latest` reflects
the action the moment it returns. The first version pushed in a `.then`, so the
model was empty for a tick — and a test reading it straight after a click got
`undefined`, then compared two `undefined`s and passed. The false pass was the
worse half of that bug.

Waiting is deliberately **not** an interaction. It changes nothing, and an
event between a click and the requests it caused sits in the middle of exactly
the sequence §15 reads.

## Ids are not automatically stable

`#submit-button` is the obvious element reference and usually the right one.
But modern frameworks generate ids, and a generated id is different on every
render — a selector built on one looks perfectly stable in review and is wrong
on the next page load. §36.2 compares two scans of one fixture, and a reference
that changes between them fails every comparison for a reason that has nothing
to do with the application.

So an id is used only if it survives these rules:

<!-- generated from GENERATED_ID_RULES; a test fails if this drifts -->

| Rule                    | Pattern                                                                          | Why an id matching it is not a handle                                                         |
| ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `react-useid`           | `^:[a-z0-9]*:$\|:r[0-9a-z]+:`                                                    | React 18's useId() emits `:r0:`-style ids that change with render order.                      |
| `framework-counter`     | `^(ember\|mui\|radix\|headlessui\|chakra\|mantine\|ant\|v-)[-_:]?[-_a-z0-9:]*\d` | Component libraries append a per-instance counter that shifts as the tree changes.            |
| `hex-or-uuid`           | `[0-9a-f]{8}-?[0-9a-f]{4}\|^[0-9a-f]{12,}$`                                      | A hash or UUID is regenerated per render or per session.                                      |
| `hex-token`             | `(^\|[-_])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}($\|[-_])`                | A short hash embedded in an id — `el-8f3c2a1b` — is regenerated whenever the thing is.        |
| `long-digit-run`        | `\d{5,}`                                                                         | Five or more consecutive digits is a counter or a timestamp, not a name someone chose.        |
| `generic-prefix-number` | `^(id\|el\|elem\|item\|node\|comp\|c\|x)[-_]?\d+$`                               | A generic word plus a number is a generated handle; a human-chosen id says what the thing is. |

A false positive here costs a weaker selector; a false negative costs a
selector that silently breaks. The asymmetry is why the rules lean towards
rejecting.

## The strategy ladder

First rung that applies wins, ordered by how well each survives a change to the
page. The strategy and a `stability` rating are recorded alongside the
selector, because a `positional` reference that quietly became the wrong
element is worse than one a reader knew to distrust.

| Strategy          | Selector                                    | Stability                                                   |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `test_id`         | `[data-testid="…"]`                         | strong — the attribute exists to be stable                  |
| `id`              | `#…`                                        | strong, once the rules above have passed it                 |
| `name`            | `tag[name="…"]`                             | moderate — scoped by tag, since a radio group shares a name |
| `anchored_path`   | `#stable-ancestor > tag:nth-of-type(n)`     | moderate — survives changes above the anchor                |
| `structural_path` | `body > form > div > button:nth-of-type(2)` | positional — a new sibling breaks it                        |
| `tag_only`        | `button`                                    | positional                                                  |

Derivation happens here rather than in the browser layer. The adapter reads the
DOM facts; turning them into a selector is a pure function, and keeping it out
of the browser is what makes "reproducible across runs" testable without one —
it is a property of the function, and a table of inputs proves it far better
than a page can.

## What is never recorded

The text that was typed. A scan types credentials into login forms; the event
store is raw and local, but exports are not (§37.2), and the selector alone is
enough to reproduce the step without carrying the secret through every
downstream stage.

## Boundaries

See the dev plan §1.2 (dependency direction) and §2 (modularity contract).
Consumers import from the package root only — deep imports are an eslint error.
