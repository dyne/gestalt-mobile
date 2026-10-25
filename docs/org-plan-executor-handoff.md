# Supervised executor handoff recovery

A source reproduction of Mobile 0.55.5 shows that the accepted L1's executor
can remain in controller state after the next canonical executor is observed.
The active-root activity path did not persist that change; lifecycle enforcement
returned before reconciliation when attention was pending. Health read the stale
assignment, so repeated approval/resync could not repair it. This explains a
reproducible source failure; inaccessible remote logs do not prove the exact
incident timeline.

Ownership observation now runs independently of execution permission. Plan,
activity and health paths reconcile the unique current canonical writer. Health
can refresh the owning app-server's bounded direct-child topology without a
model turn, thread resume or detached reader. Parent ownership and physical
identity must be verified. Observations racing newer activity are discarded.
Accepted predecessor review gates, no active predecessor turn/process, sole
writer identity, closed assignments and authorized generation rules remain.
An idle completed predecessor may remain in the roster. An interrupted writer
remains resumable; an explicitly closed writer stays terminal.

`executorBinding` reports readiness, a precise code, canonical position and one
recovery action. Its `authorizesExecution:false` states that observation alone
cannot dispatch work. Reconciliation preserves Manual Off, pending attention,
controller generation and execution permission. It resets predecessor retry
state on a new milestone and retains superseded command evidence. It does not
fabricate effective settings. Configured/strict policy semantics are unchanged.

## Recovery after an authorized update

1. Record the resolved Mobile path/version, Codex/Agents versions, previous
   package artifacts, exact session/root and existing writer identity. Back up
   normal persistent state without modifying it. Do not substitute a Codex ID
   for an unverified relay-session ID.
2. Build/test these Mobile and matching Agents commits with existing locked
   dependencies. Package through the normal release pipeline only with separate
   release authorization. Do not patch installed node_modules or global profiles.
3. With separate installation/restart authorization, use the supported Gestalt
   updater (inspect `gestalt update --help` for that installation first). Verify
   installed revisions contain both the controller and instruction changes.
4. In the existing session, call `gestalt_org_plan_health` once. For the reported
   handoff expect current position L2, the existing l2 physical thread,
   `executorBinding.status:ready`, configured admission allowed and no contradictory
   observed settings. Missing effective receipts remain unknown.
5. Resolve the existing attention through the normal control. Resume that same
   writer only when normal continuation fences permit; Manual Off stays Off.
   Verify no replacement/duplicate, one supervised report, independent review,
   checkpoint acknowledgement and subsequent continuation. Preserve all evidence
   and terminal whole-branch review gates.

If ownership remains unavailable/conflicted, keep the existing writer paused
and report the exact binding code. Repeated approval is not reconciliation.
Do not delete policy metadata, fabricate receipts or directly edit controller SQL.

Rollback: pause automation through the normal control, preserve the current
writer and evidence, and restore the recorded Mobile/Agents package artifacts
through the supported installation process with restart authorization. No new
storage schema is introduced. Do not replay issued commands, reuse a closed
assignment or restore an old database merely to hide the conflict. Revalidate
health before continuing; the older build may again exhibit stale handoff.

## Validation scope

The source regression crosses production composition, SQLite, activation,
admission and dispatch, then synthetic executor report/checkpoint handling.
A separate composed handoff test observes the second physical writer while the
root and attention are active, preserves the existing interaction and performs
no extra start/resume. It also rejects a read racing newer root activity.
Unit coverage includes Off, repeated resync, stale/wrong-root/ambiguous topology,
unreviewed/live predecessors, unauthorized generations and interrupt/close.
These runtime replies and accepted-review projections are synthetic.

The isolated live source smoke reaches configured admission and a real root
turn, then reports sandbox/skill limitations before any canonical executor or
sentinel/checkpoint. It is not a successful live end-to-end test. The remote
session logs/state are unavailable here; no installed candidate was deployed.
The next installed update is therefore not yet verified to unblock that plan.

Verification on Node 24.22.0 / Codex 0.164.0:

| Command / scope                                                                 | Result                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                                                      | 2,598 passed, 3 skipped; 330 files passed, 2 skipped                                                                           |
| `npm run format:check`, `license:check`, `check`, `lint`, `build`               | All exit 0                                                                                                                     |
| Cross-package accepted-checkpoint selector (below)                              | 2 tests passed, 207 excluded; one file excluded by selector                                                                    |
| Agents shell suite                                                              | 36 scripts passed; skills discovery not run because its dependency is uncached and installation is unauthorized                |
| Agents instruction contracts / skill validator                                  | 67 scenarios passed; Org skill valid                                                                                           |
| `npm run test:e2e`                                                              | 228 failures at browser launch: Playwright Chromium executable absent; browser behavior unverified                             |
| `npx tsx scripts/org-plan-prelaunch-probe.ts`                                   | Real owned-root catalog and empty direct-child topology reads passed; zero model turns, no child execution                     |
| `npx tsx scripts/org-plan-policy-smoke.ts --execute --agents ../agents-handoff` | Real configured admission/root turn reached; sandbox/skill attention before canonical executor startup, sentinel or checkpoint |

Cross-package command (the helper path is the paired source worktree):

```sh
GESTALT_TEST_ORG_PLAN_HELPER=/home/gestalt-dyne/gestalt-workspace/.gestalt/repairs/agents-handoff/plugins/gestalt/skills/org-plan/scripts/org-plan npx vitest run src/server/features/plans/application/model-policy.test.ts src/server/features/autopilot/application/service.test.ts -t 'hands accepted L10 to exactly one root turn|hands accepted L9 through a nested stack|model policy'
```

Independent source review accepted both worktrees with no outstanding findings.
No successful installed-update or remote-plan recovery claim follows from these
results. Full live activation → executor dispatch → execution → independent
review/checkpoint remains to be demonstrated in the authorized installed candidate.
