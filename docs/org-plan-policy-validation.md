# Org-plan compatibility repair validation

Source validation on 2026-10-24. This report does **not** establish that an
installed update unblocks the reported Bitcoin plan.

## Cause and scope

Mobile's v1 admission had no success path: valid policies unconditionally returned
`RUNTIME_ATTESTATION_UNAVAILABLE`. The adapter itself reports no runtime settings
revision, so neither approval nor child creation could satisfy that prerequisite.
Manual Off and admission denial are separate facts. The provided health/source
evidence supports this mechanism; no complete incident timeline was reconstructed.

Repair branches are `fix/org-plan-policy-compat` in Mobile, Agents and CLI,
based respectively on `afc4e46a6e71`, `3f880eb2ca1e` and `d0a872c3c27b`.
The repair also corrects the versioned launch prompt's old Terra/high recipe and
automatic executor resumes using session defaults. CLI doctor now recognizes
the coordinated configured-assurance capability scope.

Existing v1 plans without an assurance keyword select disclosed configured
compatibility. Requested policy fields remain intact. Explicit
`MODEL_POLICY_ASSURANCE: runtime-attested` remains strict and blocked on this
adapter; it is never silently downgraded. Configured mode is cooperative
supervision with launch/catalog validation and controller-owned resume fences,
not universal interception of native collaboration calls or runtime attestation.

## Automated evidence

| Command / scope                                                          | Result                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Mobile `npm test`                                                        | 328 test files passed, 2 skipped; 2,557 tests passed, 3 skipped; exit 0                                 |
| Mobile `npm run format:check`, `license:check`, `check`, `lint`, `build` | Each exit 0; Svelte check reports zero errors/warnings                                                  |
| Mobile production composition and runtime admission focused suite        | 90 tests passed before the additional identical-plan republication case; final race selection: 6 passed |
| Agents `npm_config_offline=true bash tests/run.sh`                       | 31 scripts completed before offline skills discovery failed                                             |
| Agents remaining Gestalt/context-mode scripts                            | All 5 passed; 36 completed scripts total; full runner remains incomplete                                |
| Agents schema / launch / model-policy integration                        | 21 / 15 / 13 cases passed, zero failed or skipped                                                       |
| Agents instruction contracts / skill validator                           | 64 scenarios passed; `quick_validate.py` reports valid                                                  |
| CLI `node --test tests/supervision-capabilities.test.mjs`                | 41 passed, zero failed                                                                                  |
| CLI `bash tests/gestalt-cli.test.sh`                                     | PASS, including matched/new, mixed and malformed manifests                                              |
| CLI `bash -n public/gestalt`; ShellCheck on changed shell files          | Passed                                                                                                  |
| CLI `npm run build`                                                      | Passed                                                                                                  |

The full CLI suite stops at four native Serena cases: default-approval,
dual-profile-child, serena-only-resume and edit-approval-denied. The same four
failures reproduce with `node --test tests/serena-cli-native.test.mjs` on an
untouched detached checkout of CLI `main` (`d0a872c`). They are not counted as
passing and were not changed by this repair.

Agents discovery needs `skills@1.5.18`, which is absent from the offline npm
cache (`ENOTCACHED`). No dependency was installed to bypass that limit. Mobile
`npm run test:e2e` reports 228 failures because the expected Playwright Chromium
headless executable is absent. Browser behavior is therefore unverified here.

## Required regression mapping

| Requirement                   | Evidence                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Existing v1 activation        | Preflight compatibility test and production composition activation/catalog/dispatch test                                              |
| Explicit strict unavailable   | Parser preservation, domain rejection and production activation rejection                                                             |
| Prohibited model/effort       | Schema/admission rejection and actual adapter catalog validation tests                                                                |
| Observed mismatch             | Evidence reader model/effort/role/catalog cases and production rejected child dispatch                                                |
| Requested versus observed     | Null/unknown evidence tests; separate attestation-only health scope and `runtimeEnforcement:false`                                    |
| Stale resume/replacement      | Existing binding tests, in-flight evidence fencing, Manual Off/policy mutation/recovery revocation cases                              |
| Manual Off                    | Same-plan supervision-start idempotence and revocation-during-read tests                                                              |
| Attention / duplicate control | Configured production attention replay, repeated supervision-start and same-plan republication during read                            |
| Legacy behavior               | Existing legacy admission, runtime continuation and full-suite lifecycle coverage                                                     |
| Composition integration       | Real composition services/SQLite/adapters cross activation, admission, catalog and root/child dispatch; runtime replies are synthetic |
| Review / checkpoint           | Production report/checkpoint acknowledgement and existing review, terminal-review, checkpoint continuation and recovery suites        |

Synthetic runtime acceptance and a synthetic report do not prove real child
execution. The cross-package tests additionally run the actual edited Agents
helper with `GESTALT_TEST_ORG_PLAN_HELPER` set, covering publication and
suspend/reopen/resume retention plus single/nested accepted-checkpoint handoffs.

The direct commands are `vitest run
src/server/features/plans/application/model-policy.test.ts` (49 passed) and
`vitest run src/server/features/autopilot/application/service.test.ts -t
'hands accepted L10 to exactly one root turn|hands accepted L9 through a nested stack'`
(2 passed, 158 excluded by the selector), both with that environment variable
pointing to the edited Agents `plugins/gestalt/skills/org-plan/scripts/org-plan`.

## Live source evidence and remaining gap

`node_modules/.bin/tsx scripts/org-plan-runtime-probe.ts` starts an isolated
real Codex 0.164.0 app-server. Initialization and `model/list` succeeded; the
catalog advertises all three exact policy IDs with medium effort. No model turn
runs in this probe, and it does not provide attestation.

`node_modules/.bin/tsx scripts/org-plan-policy-smoke.ts --execute --agents
../agents` uses temporary homes, a dummy Git workspace/plan and source contracts.
It reaches `executionAdmission.allowed:true`, configured assurance and a real
root turn. The final attempt returns structured `hardBlock / externalStateChanged`
with sandbox/skill limitation categories. It produces neither the sentinel nor
a supervised checkpoint. A thread-start notification includes the root itself
and must not be described as executor-start evidence.
The attempt preceded the final identical-plan republication fence refinement
and harness-reporting refinements; no successful live run of the final commit
is claimed.

The independent sandbox probe `codex sandbox linux -- /usr/bin/true` fails with:
“error building bubblewrap command: app-server socket directory must be a
user-owned directory with mode 0700”. No sandbox/global-state workaround or active
session restart was attempted. The affected `/home/gestalt-planb/...` plan is also
unreadable here (permission denied), so its supplied fingerprint/HEAD were not
independently revalidated in this environment.

Real executor startup, execution, independent review and acknowledged checkpoint
continuation remain unavailable as a complete live chain. Nothing was installed,
published, pushed or globally deployed. Independent source review accepted all
three repositories without unresolved P0/P1; that is not installed-update evidence.

Use the [deployment and rollback procedure](org-plan-policy-compatibility.md)
to validate a separately authorized installed candidate before claiming the
reported plan is unblocked.
