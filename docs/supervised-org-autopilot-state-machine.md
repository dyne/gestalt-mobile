# Supervised Org Plan lifecycle

Gestalt treats an executor turn ending as an observation, not as completion of
the executor's objective. The durable Org Plan remains authoritative for L1 and
L2 completion and review.

## State

Each active supervised session records the canonical Org position, physical
executor task path and thread, L1/L2 state, last activity, structured outcome,
validated blocker (when present), owned processes, and continuation generation
and count. Executor outcomes are `objective_complete`, `partial`, `blocked`,
`cancelled`, or `failed`.

`blocked` is valid only with one of the decision-table reason/resume-condition
pairs accepted by the Org attention protocol. Checkpoints, incomplete work,
turn limits, elapsed time, or requests for more context are `partial`.

Agent turn state, agent idleness, process state, objective state, milestone
state, and blocker state are separate facts. In particular, a child thread can
be idle while its owned command is still running.

## Transitions

| Observation                                           | Mechanical action                                          |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| Executor turn ends while its L1 is TODO/WIP           | Resume that executor thread after bounded backoff          |
| L2 completes while its L1 remains WIP                 | Resume the same executor                                   |
| Collaboration wait times out                          | Reinspect durable plan, activity, and process state        |
| Executor owns a live process after its turn           | Transfer monitoring ownership to the supervisor            |
| Owned process exits                                   | Consume its opaque result artifact and resume the executor |
| Owned process exceeds elapsed-time or RSS policy      | Terminate that exact process and resume diagnosis          |
| User asks for status                                  | Publish status, then perform the next lifecycle action     |
| Supervisor registers a proactive long-wait lease      | Park until its first subscribed event or safety deadline   |
| Valid Org attention request exists                    | Cancel queued continuation, persist it, and stop nudging   |
| Every L1 is DONE and REVIEWED and final review passes | Allow successful termination                               |

## Checkpoint handoff

A root-owned checkpoint is a short persist-and-ack operation. It records a
completion epoch and cancels obsolete root/executor wait ownership, but it
does not start another turn. Only the matching root final releases that durable
boundary. The resulting `checkpointChanged` lifecycle input schedules the next
fenced continuation; executor idleness is never used as the handoff trigger.

Checkpoint delivery is idempotent within its plan identity, canonical position,
and completion epoch. A DONE-to-WIP-to-DONE cycle opens a new epoch only after
the authoritative plan has durably reopened that target. A duplicate, late, or
mismatched final cannot emit another milestone report or release another writer.

The checkpoint response has a bounded acknowledgement deadline. A lost response
becomes the explicit `checkpointHandoffFailed` recovery state, consumes stale
leases, and is recovered once through the root/runtime boundary. It is not
presented as an ordinary executor wait. An unsupported checkpoint protocol or a
checkpoint arriving after its owning root final fails closed before persistence.

## Executor ownership and recovery

Each canonical L1 has exactly one durable physical owner. The visible name is
always `l<a>`; a replacement is a bounded physical generation such as
`l<a>_g2`. Every executor resume, process action, and replacement handoff carries
the plan identity/fingerprint, canonical position, task path, thread, and
generation fence.

Commands persist as scheduled, issued, accepted, failed, cancelled, or
superseded. An issued command is ambiguous across process loss and is never
blindly replayed. Conflicting live generations are reconciled deterministically;
the selected owner is persisted before an obsolete writer is interrupted, and
no continuation starts until fresh single-owner evidence is available.

Repeated explicit executor rejection supersedes the exhausted physical owner
and schedules one L0-owned replacement. A replacement is invalidated if the
plan identity, fingerprint, or active L1 changes. Process transfer, result
consumption, and termination use the same durable command identity, so retries
cannot consume twice, target a reused process ID, or revive a superseded owner.

## Failure containment

Serialized Autopilot operations have a local failure boundary. A controller,
refresh, process action, persistence, or publication failure records a bounded,
sanitized diagnostic and either arms one fenced reconciliation or enters the
safe `safetyPaused` state when scheduling recovery is unavailable. The queue
then remains usable for later lifecycle inputs; failures cannot create an
unhandled rejection or a hot loop.

When durable persistence is unavailable, the independent diagnostic and one
bounded runtime reconciliation remain observable until the store recovers.
Publication failure is retained in the durable outbox and retried by its normal
journal path. Human attention is still reserved for a validated decision-table
blocker; operational uncertainty is recovered mechanically or safety-paused.

Continuation delay grows exponentially from one second and is capped at one
minute. This prevents an accidental hot spin without converting delay or
silence into a blocker. Process defaults are a one-second poll interval, two
hours elapsed time, and 12 GiB RSS. Process inspection exposes PID, elapsed
time, CPU, RSS, exit status, and an opaque result-artifact identifier; command
text and output are not persisted in lifecycle state.

The rolling automatic-action cap is subordinate to semantic progress. A plan,
review, checkpoint, executor, process, interaction, or sequenced activity change
starts a fresh unchanged-continuation budget, even when the older actions remain
inside the rolling time window. Three unchanged continuations still require a
structured probe; an invalid probe or a repeated unchanged retry safety-pauses
the session. A validated Org attention record remains the explicit stop when
the supervisor determines that progress requires outside action. Its pending
dynamic-tool request disables Autopilot and generation-fences any stale timer;
only explicit resolution and re-enabling can resume automatic supervision.

A version 2 wait lease may be registered before the unchanged-continuation
probe when the supervisor already knows an operation will outlast the normal
control interval. It stores a bounded deadline of one minute through 24 hours
and the smallest relevant semantic wake set. The first matching event or the
deadline consumes the lease and restores the ordinary pulse policy. It never
changes that policy permanently: another long wait requires a new explicit
lease in a later supervisor turn. Version 1 remains backward-compatible with
the probe-gated, event-only wait.

The dynamic-tool response is authoritative: only `accepted:true` permits the
supervisor to yield. When automatic continuation is unavailable, Mobile returns
`accepted:false` with `next:continueSameTurn` and leaves the root turn active so
the supervisor can immediately resume the executor or take the next lifecycle
action.

An `executorChanged` lease is accepted only while the canonical executor is
still observably working. If its completion is already settled or queued for
reconciliation, Mobile fences pending automatic callbacks and returns
`accepted:false` with `reason:wakeAlreadySatisfied`; the supervisor continues
in the same root turn instead of parking after the completion edge.

Long GitHub checks use the same generic process boundary. The supervisor owns a
running `gh pr checks <PR> --watch --interval 30` command and requests
`processExited` and `processResultAvailable`; Mobile observes its process state
and does not store GitHub credentials or implement a second CI polling loop.

## Final-response guard

Before a root turn is treated as terminal, the coordinator reads durable
Autopilot and Org Plan state. A final is rejected while any supervised L1/L2 is
TODO or WIP. It is allowed only after explicit disable/cancellation, a validated
attention record, or complete and reviewed milestones. Rejection emits an
audit event and schedules the next legal lifecycle action.

## Executor names and migration

The visible canonical name remains `L4`/`l4`. A fresh executor can use a
physical generation such as `l4_g2`, so completed historical tasks do not
reserve the canonical Org position forever.

Existing SQLite databases gain a nullable `autopilot_sessions.lifecycle_json`
column. Existing rows need no data rewrite. New lifecycle values are validated
on read; malformed values fail closed rather than authorizing a final response.
