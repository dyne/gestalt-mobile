# Org-plan supervision launch boundary

`startOrgPlanSupervision` in the plans application layer is the shared operation
for authenticated HTTP and composition-wired internal callers. Composition binds
the same authorized reference resolver and admission settings for every caller.
`POST /api/plans/execute` is a thin adapter. It accepts an opaque plan reference,
the confirmed preparation revision, an optional supervisor skill profile, and a
stable `launchId`. Paths, working folders, models and Autopilot switches are not
accepted inputs. Callers first obtain read-only `/api/plans/prepare` context.

The typed relay-client method and `OrgPlanLaunchController` work without a
mounted viewer. A trigger supplies the confirmed intent to `submit`; the
controller manages in-flight submission, keeps the same identity for transport
retries and partial receipts, and allocates another identity when confirmed
inputs change. Callers own confirmation, toast notifications and ordinary session
navigation. Disposing a controller suppresses late presentation, without
cancelling a persisted backend operation.

A `started` result means one ordinary session and accepted bootstrap request;
it does not establish model adoption, attachment or active Autopilot. A `partial`
receipt retains the ordinary session identity and the unfinished stage for safe
recovery. Reuse the same intent identity after a lost response. A conflicting
identity or stale revision requires fresh confirmation. The supervisor's real
Org-plan loading and helper publication alone activate supervision.

The operation uses the ordinary session-start application operation and the
same turn-acceptance operation as manual Chat sends. The bootstrap is built on
the server and recorded through that normal path; Execute does not pre-attach
the plan. Production-composition tests observe a simulated supervisor helper
publication through the normal filesystem status watcher, separately from the
accepted bootstrap receipt. They do not establish installed model adoption.

Before session effects, the shared operation durably reserves its launch and
ordinary session identities, canonical file, confirmed revision/project, effective
defaults and immutable profile selection. A canonical-file fence rejects competing
intents, including reference aliases. Reusing an identity with different confirmed
inputs returns a conflict. Authorized replay reads the original receipt before
fresh source admission, so its own attachment or later source changes do not
create another session or bootstrap.

An unresolved bootstrap submission retains a durable fence. Ordinary turn
submissions and this uncertainty prevent coordinator root or executor dispatch;
they do not enable Autopilot. A real supervisor publication may activate normal
supervision while the bootstrap is pending, but continuation still waits for the
ordinary safe boundary. Explicit stops and forgotten-session fences remain
authoritative.

Normal turn acceptance is durably recorded before later session/event writes.
After a lost response or relay restart, the launch reconciles that ordinary receipt
even if the bootstrap has already finished. It returns the same session and
historical acceptance receipt without sending another bootstrap. Unfinished
activation acquires the same session's writer through ordinary recovery; explicit
Stop, Close and Forget remain authoritative. A late supervisor signal cannot
enable a stopped session.

When acceptance cannot be proven, Execute returns the existing session and keeps
the bootstrap fence. Inspect normal history and send explicit recovery guidance
through Chat. Acceptance of that separate user-requested turn allows the ordinary
supervisor lifecycle to continue without inventing a bootstrap receipt or sending
the bootstrap again.

Never-published retries re-run current file, policy, workspace, profile and defaults
admission. The command can exclude its own unpublished reservation during that
read; it cannot exclude another supervisor. A stale confirmation revokes the
publication revision before releasing ownership, fencing any delayed old publisher.

Session publication and launch progress commit atomically. A retry after an unknown
publication result uses the same allocated ID and publication gate; only the current
initial-activation claim may activate it. Losing publishers return the existing snapshot without
overwriting ready, stopped or forgotten state. Rollback produces no roster event.
Already-bound sessions recover through ordinary writer acquisition. No recovery
infers owner death from a missing in-memory row, PID or elapsed time.

Publication also atomically records an initial-activation fence. If the saved
session has no provider thread, a tracked pre-request attempt can start that
same session through the normal runtime startup path. A revision check immediately
before `thread/start` prevents a delayed original preparation from starting after
a newer attempt supersedes it. Definite failures before that request boundary can
retry with the captured session settings; existing threads retain ordinary writer
recovery. Stop and Forget fence both provider startup and final publication.
Ordinary Chat uses this same guarded recovery for a tracked null-thread session.
An accepted explicit Chat turn suppresses any later automatic bootstrap; Execute
continues to report the original bootstrap as pending rather than inventing a receipt.

Once a provider thread request may have crossed, a missing receipt remains
uncertain. Execute does not start another thread or bootstrap from that state,
including after restart. Older null-thread rows without activation tracking are
also uncertain; absence of a thread ID alone never authorizes another start.

The production-composition regression also checks saved Codex defaults, a named
supervisor profile, ordinary history, authenticated event replay and roster
publication. Its provider and supervisor-publication producer are test doubles.

For a separate native boundary, with Codex/authentication, installed Gestalt skills
and the ordinary executor profile already available:

```sh
./node_modules/.bin/tsx scripts/org-plan-execute-smoke.ts --execute --org-plan-skill /existing/gestalt/skills/org-plan --report /existing/evidence/execute-smoke.json
```

This opt-in smoke consumes one real root turn in an isolated project and relay
state directory. It preserves the installed launcher environment and ordinary
sandbox/approval defaults, performs no installation, and authorizes only exact
plan loading and real helper publication before stopping. It records accepted
bootstrap and observed owning-root helper/status evidence separately. Missing
prerequisites or unobserved publication produce a nonpassing bounded receipt;
neither mocked tests nor source smoke prove an installed Mobile update.

The client `handoffSession` operation in `features/sessions/session-handoff.ts`
shares normal roster publication, selected-session caching, draft restoration and
controller selection between manual creation and Execute. The shell supplies
those ordinary adapters and chooses the destination independently. Manual new
sessions use the known-empty history hint; Execute loads normal history because
the bootstrap may already be recorded. Started and partial receipts both select
the returned persisted ID through this operation, without another launch or
client-side recovery stage.

A caller supplies an immutable presentation lease. Navigation, another session
selection or disposal invalidates it across roster and draft reads, preventing a
late response from changing the user's draft or destination. The persisted
session remains discoverable in the ordinary roster. Dismissing the modal after
submission leaves the server operation intact; leaving the viewer suppresses its
late presentation. Neither handoff nor launch turns on Autopilot or attaches the
plan through the activating open-plan endpoint.
