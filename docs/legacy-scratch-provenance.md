# Legacy scratch provenance

Clean TMP recognizes v1 managed owners by their validated ownership marker,
canonical workspace, private filesystem provenance, durable session roster and
every lease. This includes earlier Mobile v1 allocations without a `leases`
directory. No marker is synthesized to turn an unknown folder into an owner.

Older unmarked layouts cannot currently establish deletion authority. Clean TMP
counts the following directory families directly under a known workspace's
`tmp` as ambiguous retained candidates; it never follows their links or walks
their contents. A matching name alone never permits deletion. It does not scan
HOME or the operating system's temporary root.

| Historical producer                                | Source revision and path                                                                                       | Observed provenance and disposition                                                                                                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context-mode executor `.ctx-mode-*`                | Agents `de9f1bc8ab66bfcc0f64fc04941baa03752343ef`, `plugins/context-mode/src/executor.ts:286`                  | Random OS-temp directory containing generated scripts; no session/workspace marker or released lease. Retain.                                                                                                                                                  |
| Browser CLI `gestalt-cli-playwright-*`             | Launcher `758b9b7abc89d0187b5c3a51eb58ff3f8d9e0d79`, `public/gestalt:4632`                                     | Private temporary frontend/socket directory. The separate `cli-sessions` record at lines 4680–4696 stores version, provider thread ID, workspace/schema hashes and native version; it contains neither this directory's identity nor a release record. Retain. |
| XERJ regression and sandbox/Serena doctor fixtures | Same launcher revision, `public/gestalt:354`, `:2269`, `:2455`                                                 | Operation-owned random temporary directories, without a durable session-to-directory or shutdown authority. Retain.                                                                                                                                            |
| Chrome/skills-transfer/manager downloads           | Same launcher revision, `public/gestalt:2074`, `:3362`, `:3556`, `:3653`                                       | Shell temporary download/transfer directories; no session marker or released lease. Retain.                                                                                                                                                                    |
| Mobile v1 managed allocations                      | Mobile `ba25c5cc77894d32dd094836567467e22504899a`, `src/server/platform/scratch/filesystem-session-scratch.ts` | Actual v1 markers bind the selected canonical workspace and hashed relay owner to the durable roster. Existing managed validation applies; no prefix-based legacy exception.                                                                                   |

The positive compatibility fixture stores that unmodified historical Mobile
allocator as `test/fixtures/scratch/mobile-v1-producer.ts.txt`, SHA256
`889e8b7785b6e18a8ff51b17c3d01f3992bcb8ea0f7724d616be31cd613ef916`.
Tests execute it in an isolated workspace, then verify orphan removal and durable
saved-owner preservation. Bundling the immutable source also supports shallow
CI checkouts without fetching history. The older unmarked families above remain
unsupported for deletion; this fixture does not grant them authority.

Installer staging, cloned source, browser profiles, Kimi state, indexes,
context-mode databases and evidence keep their existing persistence rules.
For example, the old Agents `ctx-upgrade-*` Git clone is installation staging;
it is not eligible merely because it was placed in a temporary directory.

Forgetting can target only positively attributed managed owners. It cannot
attribute an unmarked legacy folder to a forgotten session. A future legacy
recognizer needs an actual historical ownership/release authority and a safe
coordination mechanism; neither a new invented marker, prefix, age, PID absence,
script contents nor a provider history mention supplies that authority.
