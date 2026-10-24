# Org-plan model policy compatibility

See the [source validation report](org-plan-policy-validation.md) for exact test
results and the incomplete live/installed validation boundary.

The previous admission function rejected every valid version-1 plan because
the current Codex adapter cannot produce an attested settings revision. Approval,
attention resolution and creating a child could not change that decision.
Activation also preceded child creation, so demanding an attested child there
would be circular. A separate stale launch prompt selected fixed Terra/high,
and automatic resumes used session defaults rather than the L1's choices.

Version-1 plans now default to disclosed configured assurance. They retain their
model, effort, rationale, fallback and necessity fields. Explicit
`#+MODEL_POLICY_ASSURANCE: runtime-attested` remains blocked on this adapter;
there is no implicit downgrade of that declaration. Configured assurance checks
launch capabilities, exact catalog support and inherited permissions, retains
controller ownership, and rejects observed mismatches. It cannot attest every
runtime decision or intercept native collaboration calls. Root supervision and
review remain necessary. Missing settings receipts stay unknown.

## Deploy a reviewed update

Do not patch installed `node_modules`. Ship the Mobile source commit, matching
Agents contracts and CLI capability negotiation together through the normal
package/release process. An older CLI doctor rejects the new capability scope.
Before deploying, record `gestalt path --json`, the resolved Mobile executable,
`"${GESTALT_MOBILE_BIN:-$(gestalt path mobile)}" --version`, `codex --version`,
the installed Agents version and the previous package artifacts/lockfiles.
Retain those exact artifacts for rollback. Do not change release state as part
of source validation.

1. Build/test the reviewed Mobile and CLI commits with the repositories' existing
   locked dependencies and run the Agents suite. Package through the normal release
   pipeline; this repair does not authorize publishing or dependency installs.
2. With separate installation/restart authorization, apply the matching CLI,
   Mobile and Agents update using the normal Gestalt updater. Use `gestalt update --help`
   to verify the installed updater's supported options before running it. Do not
   guess flags or restart active sessions during source validation.
3. Verify the resolved installed executable and package capabilities actually
   contain `defaultAssurance: configured` and `runtimeEnforcement: false`.
4. In the affected workspace, validate the exact existing plan, publish
   supervision-start for its relay session and inspect health. For a v1 plan
   without explicit strict assurance, expect `executionAdmission.allowed:true`
   and `assurance:configured`. Manual Off may still be independently retained;
   enable once only if the user intends continuation. Never delete policy fields.
5. Observe one canonical executor starting with the exact selected model/effort,
   its execution/report, independent review and an acknowledged checkpoint with
   continuation. Record source, live-source and installed-update evidence
   separately. A unit/composition pass alone does not verify this installed path.

For the reported Bitcoin plan, reuse
`/home/gestalt-planb/bitcoin-workspace/.gestalt/roots-mempool-cache-review.org`.
Do not treat its Codex thread ID as a verified relay-session ID. This repair
does not authorize any Bitcoin edits or starting that plan during validation.

## Roll back

With separate authorization, stop only the updated relay at a safe boundary,
restore the recorded CLI, Mobile and Agents package artifacts through the normal
installer, and verify their executable paths/versions. Preserve plan bytes,
worktrees, commits, relay database and credentials; this change has no database
migration. Disable automation before resuming an older adapter: previous versions
will reject versioned policies again. Explicit strict assurance must remain
strict. Never roll back by deleting metadata, forging receipts or resetting
authentication state.
