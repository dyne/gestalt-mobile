# Catalog evidence before executor launch

Configured admission in Mobile 0.55.4 did not expose its pre-dispatch catalog
check to the supervisor. The separate child settings reader returned early when
no executor existed, leaving `modelPolicy.catalogRevision:null`. The Agents rubric
still said a missing catalog/revision blocks selection. Together, these could
stop a valid existing plan before spawning even though `model/list` was available.

Health now reports `executorLaunch` separately from child settings. It reads
`model/list` through the owning root/session's active writer, checks the selected
L1's exact model and effort, and discards observations if the root, plan,
projection status or selected policy changes during the read. Dispatch uses the
same catalog-read implementation and still revalidates before work starts.
The read is bounded to five seconds and never starts/resumes a child or model turn.

Expected configured prelaunch evidence is:

```json
{
  "executionAdmission": { "allowed": true, "assurance": "configured" },
  "executorLaunch": {
    "scope": "prelaunch-catalog",
    "validated": true,
    "code": "CATALOG_MATCH",
    "requested": { "model": "gpt-6.1-sol", "reasoningEffort": "medium" },
    "catalog": {
      "source": "runtime-model-list",
      "fingerprint": "digest-of-normalized-runtime-catalog",
      "revisionSource": "normalized-content-digest",
      "observedAt": "observation-time"
    }
  },
  "modelPolicy": {
    "code": "CHILD_NOT_LAUNCHED",
    "catalogRevision": null,
    "effective": { "model": null, "reasoningEffort": null },
    "attested": false
  }
}
```

The digest and time placeholders above illustrate shape, not live evidence.
The fingerprint identifies normalized catalog content; it is not a server-issued
revision or settings receipt. Child unknowns remain truthful and do not block
configured selection. `executorLaunch.validated` validates requested availability
only: respect `executionAdmission`, Manual Off, pending interactions, canonical
ownership and all independent review/checkpoint gates.

Actual `CATALOG_UNAVAILABLE`, `MODEL_UNAVAILABLE` and `EFFORT_UNSUPPORTED` results
remain failures. No guessed catalog, silent model/effort fallback or strict-mode
downgrade is introduced. An invalid mandatory plan publication cannot validate
the retained old policy. Explicit `runtime-attested` plans still fail clearly
without attestation support.

## Recover the reported supervisor stop

Install the coordinated Mobile and Agents source updates only through the
separately authorized update/restart procedure. No plan rewrite or dependency
installation is needed for this change. Existing CLI capability scope is unchanged.

In the affected session, read `gestalt_org_plan_health` once. For the current
L1, compare `executorLaunch` requested settings and L1 identity with the validated
plan. A current `CATALOG_MATCH` supplies the missing prelaunch selection evidence;
do not require child `catalogRevision`, an attested child or a server revision.
Use the normal lifecycle to resolve any retained, now-obsolete catalog attention
once, then continue authorized supervision while preserving Manual Off. Do not
ask the user to manufacture internal catalog metadata or repeatedly reapprove it.

If `executorLaunch` is absent, identify the loaded Mobile/Agents bridge version
gap; do not infer that the actual runtime catalog is absent. If it reports a
real catalog failure, diagnose that returned capability code and source. Never
clear attention or launch against an explicit controller denial.

## Validation scope

Automated tests cross real composition services from activation through health,
catalog validation, launch instructions and report/checkpoint acknowledgement
using synthetic runtime replies. Additional cases cover unsupported settings,
strict mode, Manual Off, stale policy/root reads, session isolation, stopped
writers, timeout and unavailable projections.

The opt-in source command `node_modules/.bin/tsx scripts/org-plan-prelaunch-probe.ts`
was exercised against Codex 0.164.0. It creates an isolated real root and uses
the edited source runtime port and validation reader. The live catalog returned
`CATALOG_MATCH` for `gpt-6.1-sol/medium` with no child, while child effective
settings/catalog revision stayed null. It started zero model turns. The controller
plan/context is an isolated fixture, not the Bitcoin plan or an installed relay.

This verifies the narrow live source catalog path. It does not establish real
executor execution, independent review/checkpoint continuation or installed-update
success for the affected plan. The earlier full live smoke's nested sandbox
limitation remains outside this catalog repair. No installation, release or
active-session restart is part of source validation.
