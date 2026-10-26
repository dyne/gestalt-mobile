# Tool efficiency observation contract

`decodeToolEfficiencyFacts` projects content-free facts from Codex app-server
notifications. It is separate from agent liveness and existing session token
accounting. The feature owns the transport-neutral record; the Codex platform
adapter owns protocol decoding. Aggregation and presentation consume these facts.

Each measurement carries a value, unit and source field. `null` means unknown;
zero is measured zero. Tool scope is one app-server item, with runtime, physical
thread, turn and item identity when supplied. Actor scope stays unknown without
the root thread identity. The replay key distinguishes start/completion and
runtime generations; missing correlation produces no key. Consumers must not
merge unrelated uncorrelated observations. Event keys support later deduplication;
the decoder itself is stateless.

| Fact                      | Source and meaning                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Family                    | Declared item type, MCP server/tool or dynamic namespace/tool; executable bodies are opaque. `functions.exec` is one wrapper, never inferred nested calls.                                                                                                                                |
| Duration                  | Completed command/MCP/dynamic `item.durationMs`, in milliseconds.                                                                                                                                                                                                                         |
| Delivered bytes           | Command `aggregatedOutput` UTF-8 bytes; or JSON-serialized MCP `result.content` / dynamic `contentItems` bytes, including content block structure. These scopes remain distinct.                                                                                                          |
| Raw / processed bytes     | Unknown: the current notification contract supplies neither. Audit artifact size, omitted bytes and response-budget `originalBytes` are different scopes and are not substituted.                                                                                                         |
| Truncation / completeness | Only the first documented context-mode execution-provenance or response-budget metadata envelope supplies capture, display and evidence completeness. Partial display establishes truncation. Missing display metadata does not establish untruncated output.                             |
| Retries / reuse           | Unknown: no per-call counters are supplied. Duplicate events, repeated commands and cached provider tokens do not establish tool retries or reuse.                                                                                                                                        |
| Provider tokens           | Supplied nonnegative integer fields from `thread/tokenUsage/updated` `tokenUsage.last` / `.total`, retained as thread usage snapshots. Missing fields stay unknown, including fields defaulted by newer schemas. These snapshots are never charged to individual tools or added together. |

Delivered means observed at the app-server result boundary. It does not establish
the model's eventual input size, the full subprocess output, transport frame
size, or cost. MCP `_meta` and `structuredContent` are excluded from the content
measurement, so it is not a whole MCP result size. Empty command output is zero
bytes; an empty serialized content array is two bytes. No bytes-to-token, savings,
money or quota conversion is performed.

Coverage is partial when any supported field is observed and unknown otherwise;
it never establishes full-session coverage, correctness or successful execution.
Failed calls may still have measured duration and result bytes. Unsupported and
old events retain unknown fields or produce no facts. Output bodies, arguments,
prompts, failure messages, previews and artifact references are not retained in
the fact. Context-mode metadata parsing is bounded and does not recurse through
previews, arbitrary JSON, nested execution bodies or output text.

Protocol evidence: the repository's `docs/codex-app-server.txt` and schemas from
the supported Codex CLI (`codex app-server generate-json-schema`) define the item
and usage fields. Context-mode's `execution-provenance.ts` and `response-budget.ts`
define the narrow metadata envelopes; their audit and overflow artifacts remain
owned by context-mode and are not read by this adapter.

## Aggregation and replay

`ToolEfficiencyProjection` replaces each correlated call's start with its
completion. The call identity is runtime + physical thread + item, independently
of notification arrival time. A late start cannot replace a completion; duplicate
semantic facts do not publish a new snapshot. Older competing facts of the same
phase cannot regress a newer one; omitted counters preserve known measurements.
Resumed child turns keep their physical actor
group; a new runtime generation gets a separate group. The adapter never creates
child calls by parsing `functions.exec` bodies.

Groups separate runtime, physical thread, actor and family. Wrapper and tool
groups are separate, with no combined grand total. Durations and bytes are known
partial sums, accompanied by measured-call coverage against that group's observed
calls. Missing measurements stay null. Completeness counts distinguish explicit
unknown from missing metadata. Provider usage snapshots are ignored by this
projection; existing session and plan accounting remain authoritative.

The SQLite projection retains up to 1,024 correlated calls across 64 groups per
session independently of event journal retention. It preserves existing keys
instead of evicting them and recounting old replay. If capacity is reached, new
calls are omitted and `retentionLimited` stays true; retained calls may still
complete. Events without runtime/thread correlation are omitted from totals and
set `missingCorrelation`. Runtime observations whose session actor ownership is
unknown are likewise excluded, even when a physical thread ID exists. No count
is invented for those ambiguous events.
Every snapshot has `scope: observedCallsOnly` and partial or unknown session
coverage, including sessions that started before measurement was available.

Content-free state survives server restarts and is deleted with its session.
`GET /api/sessions/:id` returns the current `toolEfficiency` snapshot. Changed
projections publish `tool.efficiency.updated` journal events containing replacement
snapshots, so reconnect consumers replace rather than add totals. A journal resync
uses the current session snapshot; it does not reconstruct totals from truncated
history. State persistence precedes event publication; a disconnect between those
writes is repaired by reading the authoritative session snapshot.

Each changed persisted projection increments its revision. The client checks both
the session journal sequence and the efficiency revision: replay replaces totals,
older snapshots cannot regress them, and a higher revision can recover a saved
projection after interrupted event publication. Session changes remove the old
projection and fence late responses. The existing activity stream supplies these
updates; no second efficiency socket or polling loop is introduced.

## Reviewing a missed broad-search opportunity

Tool-family counts alone do not establish that retrieval was appropriate. Record
an opportunity as a reviewer finding tied to a concrete task and candidate:

1. Record the repository identity, candidate commit/tree revision, task scope and
   the relevant observation interval. Keep private task bodies in their existing
   authorized evidence location, not in Mobile analytics.
2. Obtain fresh repository-index evidence for the relevant files and revision.
   Record the source, index generation, covered paths, observation time and
   authorized evidence reference. Check that the indexed content still matches
   the candidate. A connected service, ready symbol/reference source, stale
   index, or workspace-wide discovery count does not establish covered repository
   search. If coverage or freshness cannot be established, mark the opportunity
   **unverified**.
3. Establish that the task needed a broad or uncertain search and that the covered
   index could answer it. Cite a bounded retrieval result or an authorized replay
   proving relevance and completeness. An exact known-file lookup may be the
   appropriate native operation. A tool name, command count or grep invocation
   cannot establish intent or a violation.
4. Record the finding as **missed broad-search opportunity**, with the candidate,
   task scope, coverage/freshness evidence, observed call interval, bounded result
   reference, correctness check and recommended next retrieval. Explain material
   unknowns. Use recorded duration and scoped delivered bytes only when measured;
   do not substitute missing counters or combine wrapper/tool costs.

This is a review workflow, not an automatic warning or score. A lower byte count
does not by itself prove equivalent answers, provider token reductions or savings.
