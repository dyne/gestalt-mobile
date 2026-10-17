# Chat transport and diagnostic contract

This document specifies the current browser–relay contract. It does not change the
provider protocol. Normative statements below are backed by the chat controller,
projection, history endpoint, event endpoint, and persistence tests.

## Authorities and history

Provider history is the conversation authority. `GET /api/sessions/:id/history`
reads that history and supplements it with interactions, activity, and bounded
Autopilot audit records. IndexedDB is a presentation cache, never proof that a
message was accepted or delivered. Removing a duplicate read does not remove a
conversation item or a persisted event.

The relay journal is an ordered recovery stream, not an indefinite conversation
archive. Its existing retention policy is 48 hours. Snapshot audit selection is
bounded and reports truncation. Diagnostic exports and browser caches are also
bounded; none promises a complete history of every transport operation.

## Snapshot and stream ordering

1. The browser selects a session and starts one history read and a WebSocket at
   `/api/sessions/:id/events?after=<cursor>`. Opening this initial socket does not
   start another history read. A newly created session known to be empty skips
   the initial read.
2. The relay samples `baseSequence` **before** awaiting provider history. This is
   a lower bound, not an atomic transaction spanning the provider and SQLite.
   A snapshot can already contain effects from events above the bound.
3. Events arriving during hydration are buffered. The projection reconciles
   snapshot items with stable identities and replays newer events in sequence.
   Duplicate sequences must not duplicate conversation items. A sequence gap
   requires another authoritative snapshot.
4. A WebSocket subscribes before loading replay and merges buffered live events
   with the replay tail. The per-connection cursor suppresses duplicate delivery.
   Replay reads use a fixed upper sequence and indexed metadata before payload
   decoding.
5. More than 200 retained replay events, more than 512 KiB of stored JSON, or a
   missing first requested sequence produces `relay.resyncRequired`. The browser
   reads a snapshot and replaces the old socket at the recovered cursor. The
   replacement socket does not immediately request the same snapshot again.

`relay.resyncRequired` is a recovery instruction, not a declaration that provider
history was deleted. Sequence cursors are session scoped. Browser selection
versions prevent responses for an earlier selection from updating the new one.

## Retries and observation

Only one history read per current selection is in flight. Further refresh calls
join that promise. Failed reads retry after 250, 750, and 1500 ms; after exhaustion
the shared error notification is used. Socket reconnect delay grows from one
second to a ten-second cap and resets on open. Reconnecting an ordinary socket
refreshes history; recovering a snapshot replaces the socket without that extra
read. A 25-second server heartbeat detects dead connections. Slow consumers can
be closed with code 1013.

There is currently no dedicated history-read deadline in this controller. A
pending read can therefore remain pending until the underlying request settles.
The UI's “Connection interrupted. Reconnecting…” status also covers snapshot
recovery; it is not evidence by itself of a network interruption. Provider read,
relay response, browser receipt, and UI rendering are distinct boundaries.

## Bounded transport evidence

Transport diagnostics are stored separately from `session_events`. Recording
transport never increments the event cursor and never triggers WebSocket traffic.
The production relay records:

| Observation                    | Stored metadata                                                                    | Meaning                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Completed history HTTP request | Session, record ID, completion timestamp, elapsed milliseconds, status             | One actual server response; repeated requests remain separate records |
| Replay decision                | Session, record ID, timestamp, elapsed milliseconds, requested cursor, event count | Replay selected by the relay; not proof the browser received it       |
| Resync decision                | Session, record ID, timestamp, elapsed milliseconds, requested cursor              | Relay selected snapshot recovery                                      |
| Client history counters        | Optional numeric `attempts` and `coalesced` values                                 | Browser-reported cumulative observations as of request start          |

The controller exposes `transportDiagnostics` for the current selection. It counts
history attempts, coalesced refresh calls, resync instructions and socket
constructions. A coalesced refresh is an invocation avoided, **not** a duplicate
HTTP request sent. These counters reset on selection/disposal. History requests
carry attempts and coalesced counts in `x-gestalt-history-attempts` and
`x-gestalt-history-coalesced`. Clients without these optional headers remain valid.
Counters are untrusted observations, must not control recovery, and must not be
summed across responses or compared across tabs/selections as one timeline.

Coalescing during a pending request is reported on a later history request. The
latest local counters can be lost when the page closes before another request.
There is no background upload or durable browser receipt acknowledgment. Server
traces cannot reconstruct these missing observations, abandoned requests, socket
close causes, or render timing. A request ending before instrumentation was
installed cannot be recovered retrospectively. The fix does not invent records
for duplicate requests that the old implementation never recorded.

Storage retains at most **2048 records globally** and at most **48 hours** in
exports. Writes prune old and excess rows; idle databases may physically retain
expired rows until the next write, but exports exclude them. Forgetting a session
cascades its diagnostics. A busy session can evict another session's records.
The control-plane JSON export includes `transport.available`, `coverage:
"retained-only"`, limits, and retained records. Older databases report
`available: false`; an empty list never proves no transport activity occurred.
Telemetry is best effort: a storage failure must not fail chat delivery.

Only fixed event kinds and bounded nonnegative numeric fields are accepted.
Exports reapply the allowlist. Request bodies, response bodies, exception text,
URLs, cookies, authorization headers, prompts, model output, and environment
values are excluded. Response sizes, client/server correlation tokens, explicit
recovery reasons and browser receipt acknowledgments are not collected in this
version. Adding them requires extending this contract and its privacy tests;
it must not entail logging arbitrary request or provider objects.

## Compatibility and verification

This is an additive diagnostic extension. Existing snapshots and event envelopes
retain their wire format; old clients ignore the diagnostics, and old servers
ignore optional counter headers. There is no new endpoint or authentication flow.

Regression tests cover initial hydration without duplicate reads, gap/resync
recovery, generation isolation, duplicate requests remaining individually
observable, coalesced refresh counts, bounded independent storage, expiration,
legacy databases, and exclusion of arbitrary content. Canonical conversation
history and the existing journal retention policy are unchanged.
