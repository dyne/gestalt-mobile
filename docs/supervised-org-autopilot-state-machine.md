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
