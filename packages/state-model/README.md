# @browserrecon/state-model

A lightweight, derived application state graph.

## Owns

§19's transitions: `from`, `to`, the trigger that caused it, the APIs observed
across it, and the events it was derived from.

## Derived, and never anything else

§19 says the model "does not need to be perfect in V1. It should be labelled
as derived and improve across versions." Both halves matter, the second more.

An imperfect state model is useful — knowing a scan went `cart_empty →
cart_has_item → checkout_started` tells a reader what the application does
even if one label is wrong. An imperfect state model presented as observed
fact is worse than none, because the mistakes are invisible and a reader
builds on them.

`provenance` is the literal type `"derived"`, so producing an observed
transition is a compile error rather than a review comment.

## States are named from evidence

A name comes from something in the log: the auth context, a route, or a
resource the application created. A `POST` returning 201 against `/api/orders`
produces `order_created` — §19's own vocabulary, taken from the URL. Nothing
here decides a page is "the checkout screen" because it looks like one; that
is a model's job in M4, with its own provenance.

When nothing qualifies, the state stays unnamed. `/api/{id}` produces no
state, because a state called `{id}` is worse than one fewer state.

## Two things found by testing

**The log's tail was being dropped.** The first version merged the API stream
and the event stream with a nested loop, which never processed an event after
the last API call — including a logout, which is the one most worth recording.
It is one merged pass now.

**`status` became `statu`.** Singularising a trailing `s` is right for
`orders` and wrong for anything ending in a vowel + `s`. English is not worth
guessing at further than that.

## Boundaries

§1.2: consumes events, imports no `browser/*` or `discovery/*`. Tests build
models from literal arrays.
