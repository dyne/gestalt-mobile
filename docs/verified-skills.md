# Optional verified skills

The [Dyne.org collection](https://github.com/dyne/gestalt-skills) is independent
of the Gestalt infrastructure plugin. Collection version `0.1.0` contains the
ordinary optional skill `nuklear-gui`; it provides development guidance, not a
compiled or physically qualified Nuklear application.

The manager's `gestalt install` and `gestalt update` include collection
maintenance. To maintain only this collection, use:

```sh
gestalt skills install
gestalt skills update
gestalt skills status --json
```

The stable collection is `$CODEX_HOME/gestalt-skills`, with discovery links at
`$CODEX_HOME/skills/<name>` (`CODEX_HOME` defaults to `~/.codex-gestalt`). Native
Codex discovery returns the canonical managed `skills/<name>/SKILL.md` path.
The installer-owned `receipt.json` lives outside the discovery tree. User skills,
system skills, plugins and saved profiles are preserved.

Open **Manage skill profiles**, change the optional checkbox and save a complete
selection. Choose that profile when creating a new session. An enabled skill is
available for normal triggering; it is not loaded on every task. Running sessions
retain their startup selection. Disabled choices survive collection updates, and
new paths absent from a complete saved profile remain disabled until selected.
Infrastructure advertisement and conditional runtime readiness stay independent.

**Gestalt verified** means the server checked the canonical upstream receipt,
manifest membership and current bundled file digests. It does not imply enabled
state, always-active instructions, tool readiness or an independent security
audit. Missing/tampered receipts, local modifications and explicit source
overrides lose the badge while remaining ordinary selectable skills. Local
checksums do not protect against someone who can replace both content and receipt.

## Reproduce the isolated installed flow

The opt-in qualification uses the actual manager collection installer, published
upstream revision, native Codex discovery, production Mobile catalog/profile
services, and the built client. It starts actual native threads with the profile's
compiled skill configuration, reads native process configuration/catalogs, then
archives the threads and closes their processes. It never starts a model turn.
These are separate operations in the documented
[Codex app-server protocol](https://learn.chatgpt.com/docs/app-server).
The ordinary local skill and a disposable `gestalt:org-plan` plugin entry are
controls; this does not qualify an entire infrastructure plugin installation.

With Node 24+, the repository dependencies and native Codex already available:

```sh
npm run build
export VERIFIED_SKILLS_WRAPPER=/absolute/path/to/gestalt/public/gestalt
export VERIFIED_SKILLS_REF=979d1b617076e3a03d5eb9f371a3b29864ab38c6
export VERIFIED_SKILLS_EVIDENCE_DIR=/absolute/path/to/private/test-evidence
npm run test:e2e -- --config playwright.verified-skills.config.ts
```

Use an installed test browser, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable. `VERIFIED_SKILLS_CODEX`
can select an existing Codex executable; `VERIFIED_SKILLS_PORT` defaults to 4187.
The test creates fresh homes under the evidence directory and serves only on
loopback. It does not touch a running Mobile instance, personal browser profile,
real home, or provider credentials. Preserve the generated evidence privately.

The initial installation and unchanged update use the genuine default upstream
without `GESTALT_SKILLS_SOURCE`. The content-update test creates a disposable
local Git revision, adds one skill, and updates through an explicit local source
override. That step is intentionally unverified; it never publishes the artificial
revision. The flow checks saved deactivation, re-enabling, new-path exclusion,
missing/tampered receipt behavior, native thread creation, and current screenshots.

This opt-in collection flow does not bootstrap Agents/Mobile with a complete
`gestalt install`. The CLI lifecycle suite covers those default install/update
hooks separately. Kimi materialization has adapter/filesystem coverage; native
Kimi execution requires its own installed runtime and is not established here.
