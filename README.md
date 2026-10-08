# Gestalt Mobile

Mobile-first web relay for [Gestalt](https://dyne.org/gestalt) orchestrated
development with durable Codex sessions.

## Prerequisites

- Node.js 24 or newer.
- The `codex` CLI installed, available on `PATH`, and authenticated. Gestalt's
  launcher establishes the environment and Mobile starts `codex app-server --stdio`
  directly within it.
- Optionally, the `kimi` CLI installed and available on `PATH` to offer Kimi
  as a second chat provider (see "Kimi provider" below).

## Install and run

Run the latest release without a permanent installation:

```sh
npx gestalt-mobile --cwd .
npx --yes gestalt-mobile@latest --cwd ~/devel --port 3000
```

For frequent use, install the executable globally:

```sh
npm install --global gestalt-mobile
gestalt-mobile --cwd .
```

The command prints the loopback URL when it is ready. Open that URL in a
browser. Choose **Quit** from the configuration menu and confirm to stop the
HTTP server and every managed Codex or Kimi process, including running work.
Pressing Ctrl-C or sending SIGINT or SIGTERM uses the same clean shutdown path.

Use `--icon <path>` to replace the installed PWA application icon with a local
SVG or PNG. Relative paths resolve from the directory where Mobile is started:

```sh
gestalt-mobile --cwd . --icon ./branding/project-icon.svg
```

Without `--icon`, Mobile keeps its packaged Gestalt icons. SVG icons are
declared scalable; PNG dimensions are read from the file. A square PNG of at
least 512×512 is recommended for consistent launcher presentation.

### Run this checkout

`npm run start` builds and runs the current checkout with the same managed
`CODEX_HOME` and `GESTALT_HOME` defaults as `gestalt mobile`. Explicit overrides
remain authoritative. The wrapper also prepends the usual user command paths so
locally installed `codex` and `kimi` executables remain discoverable. It defaults
to port 3001 and isolated state under `.gestalt/start-state`, allowing the managed
instance to remain on port 3000; pass explicit `--port` or `--data-dir` options to
override either default.

For live development, run `npm run dev` and open `http://localhost:5173`.
Vite proxies API and WebSocket traffic to the source server on port 3001, so a
managed Gestalt Mobile instance can continue using port 3000. Development uses
repository-local relay state under `.gestalt/dev-state` and disables passkey
access control; it remains loopback-only and does not reuse production state.

## Session defaults

The Sessions tab starts with the session base, Skills profile and Model (`gpt-6.1-sol`).
Expand **Advanced settings** to change model thinking, the Org-plan executor model
and thinking, provider, sandbox, or approval policy, or to manage skill profiles.
The executor starts with `gpt-5.6-terra` and high thinking; the supervisor uses medium thinking.
Executor overrides preserve the installed role instructions and belong to each new session.
**Save as defaults** stores the
current session settings in `~/.gestalt/session-defaults.json` on the relay host.
New browser visits load those settings; Advanced settings starts collapsed.
On desktop, Advanced settings groups the Org-plan executor and Main supervisor side by side;
on phones, the groups stack. Recent sessions expose **Copy to CLI** directly, and the header
menu offers **Copy session to CLI** for the selected session while viewing Chat.
Without saved settings, Mobile uses the workspace root, the default skills
profile, Codex, Git-writable workspace access, and automatic approvals.

## Plan discovery

The Plan catalog searches from the application-wide `--cwd` root, regardless of
the selected session or new-session base. It lists `.org` files inside any
`.gestalt` folder below that root, including folders inside repositories.
Discovery uses `bfs` when installed, falling back to `find`, with NUL-delimited
paths and without following symlinks. Other Org files remain accessible through
links in their session's chat.

The relay caches parsed entries, checks file metadata in parallel, and rereads
only changed files. Concurrent catalog requests share a scan; results are reused
for one second for internal callers; browser catalog requests always check for changes.
The browser keeps its previous catalog visible during refreshes and retries.
Switching to or clicking the Plan tab refreshes it, without periodic polling.
The **ORG Plans** heading reserves space for an inline refresh indicator,
and plan rows show compact paths, completion bars, and right-side **Open** and
**Archive** actions. Archive adds the standard `ARCHIVE` Org file tag while
preserving task state, existing tags, and content; tagged plans join
**Completed and archived**, where **Reopen** is the only action. Plan previews
start at the top when opened; later live task changes can still scroll to the
current task. Opening a
catalog entry reads it relative to the application root; chat links retain their
session-relative interpretation.

## Skill profiles

Global profiles live in `~/.gestalt/skill-profiles/<name>.yml` and use version 1 YAML:

```yaml
version: 1
name: focused
skills:
  - name: typescript-advanced-types
    path: /absolute/path/to/SKILL.md
    enabled: true
```

Use `gestalt-mobile --skills focused` to apply that profile to every Codex child,
or `gestalt-mobile --skills list` to inspect saved profiles and their enabled
skill paths without starting the server. Without `--skills`, a workspace
`gestalt-skills.yml` is used when present; otherwise Codex-native selection is
preserved. Explicit profiles take precedence over project defaults, which take
precedence over native configuration. Gestalt Mobile never rewrites Codex
configuration or skill files. Exact skill paths remain authoritative, while
paths inside Codex's versioned plugin cache are rebound to the currently
discovered plugin version when their marketplace, plugin, and skill-relative
path still match. Fixed Gestalt workflow skills are session infrastructure: Mobile
always enables and advertises them, including skills
added after a profile was saved. The editor labels them **Always advertised**
and does not offer a disable control. Refresh discovery and start a new session
after upgrading Gestalt Agents; running sessions retain their startup catalog.

`gestalt:xerj` is conditional retrieval infrastructure. For Codex, Mobile checks
the manager's shared readiness contract and the owning thread's native MCP
connection before accepting its first turn. Ready retrieval is mandatory even
when a saved profile excluded it; unavailable retrieval is excluded even when
a legacy selection enabled it. Fresh runtimes, resumes and process recovery
repeat the check. Native child agents inherit their parent's configuration and
open their own MCP connections. A connection failure appears in the existing
chat activity; use `rg` and current source reads until the next runtime check.
Instructions already delivered during a turn cannot be retroactively removed.

`gestalt:serena` is optional semantic navigation and editing for Codex sessions.
It is enabled only when the selected profile permits the discovered skill,
native hooks are enabled, the manager installation is valid, and the owning
thread's MCP connection exposes the expected tools. XERJ and Serena have
independent availability and fallback. A connected catalog proves the connection;
language readiness remains unverified until a model-authorized
`get_symbols_overview` call succeeds on a current source file. On failure, use
native code tools. Connection failures appear in session activity and the shared
warning notifications; resumes and process recovery recheck availability.
Running sessions retain their selected profile; apply a changed profile by
starting a new session.

The manager launches Serena with native `--context codex --mode editing`.
Read-only sessions still retain their actual native filesystem policy; neither
Mobile nor a listed editing tool grants write authority. Native child agents
inherit their own effective permissions and approval rules, and plan mode
prohibits edits. Mobile does not install/update Serena, switch projects or modes,
or automatically approve its tools. Codex's default tool approval is prompt:
with approval policy `never`, prompted tools are denied. Operators may explicitly
set `mcp_servers.gestalt-serena.default_tools_approval_mode = "approve"` for a
trusted server while preserving native filesystem confinement. Per-tool rules,
such as `tools.replace_symbol_body.approval_mode = "prompt"`, remain authoritative.

Serena executables are shared under `$GESTALT_HOME/serena`; writable project
state belongs to the canonical session workspace's `.gestalt/serena`, never
Mobile's application root or another session's workspace. Each native thread
owns its stdio connection; stopping Mobile closes only its owned processes.
The configuration menu lists the validated manager-provided Serena, uv, and
Python versions, or **Unavailable** when metadata is missing or invalid.

Install or update explicitly with `gestalt serena install` and
`gestalt serena update`; inspect versions with `gestalt serena version`.
`gestalt serena doctor --cwd /absolute/project --json` checks installation and
project language services with operator authority; its success does not prove a
session's permission-constrained semantic readiness. `gestalt serena index --cwd
/absolute/project` is an explicit operator action. Language services may need
the language runtime and the project's dependencies/build configuration (for
example Python dependencies or a TypeScript project's dependencies). Missing
services or restricted session network/bootstrap access produce a fallback;
permissions are never broadened to repair them. Kimi behavior is unchanged.

Managed launch provides `GESTALT_MANAGER_BIN`. Direct Mobile launch discovers
`gestalt` on `PATH`, or accepts an absolute executable path through that same
environment variable. Without a manager or installed xerj, chat starts normally.
`XERJ_READY_TIMEOUT_MS` bounds optional readiness, including discovery and the
actual connection, with a five-second default. Startup never installs xerj,
downloads models or indexes repositories. Install explicitly with
`gestalt xerj install`; inspect readiness with `gestalt xerj status`.

The manager owns one authenticated loopback backend shared by CLI and Mobile.
Closing either client closes only its native MCP proxies. Use
`gestalt xerj stop` for explicit managed shutdown; a later eligible runtime can
start the installed backend again. An empty index remains ready: index only
repositories you explicitly select, verify repository identity and freshness,
and confirm retrieval results against current source. See the manager's
[xerj setup and lifetime documentation](https://github.com/dyne/gestalt/blob/main/start/install.md).

## Kimi provider

When the `kimi` CLI is found on `PATH`, the Session tab shows a **Provider**
picker next to the model selector, and the bootstrap catalog advertises Kimi's
available models next to the Codex ones. Picking **Kimi** adapts the form:
Codex-only controls (sandbox modes and approval policy) are hidden, since kimi
web governs permissions itself.

A Kimi session runs inside a dedicated `kimi web` process that Gestalt Mobile
spawns and owns (`kimi web --no-open` on a private loopback port). The session
workspace is matched against kimi web's workspace registry; chat turns,
steering while a turn is busy, interrupts, approvals, and questions all flow
through kimi web's REST and WebSocket API. Chat parity is exact: once a
session starts, `/model` in the composer offers only that session's own
provider models — a Codex chat switches between Codex models only, and a Kimi
chat between Kimi models only. The model cannot be switched across providers
inside a chat.

Skill profiles apply to Kimi sessions too. Because `kimi web` has no
`--skills-dir` flag, Gestalt Mobile materializes each skill profile as an
isolated kimi web state directory (a separate `kimi web` process per active
profile, keyed by the profile's skill selection) under
`~/.codex-gestalt/gestalt-mobile/kimi/`, so profiles with different skills
enabled never share a runtime. Authentication is shared by symlinking it from
`~/.kimi-code`; Gestalt never copies or rewrites kimi credentials.

Kimi sessions stay on core chat: org-plan/autopilot tooling (the Plan tab,
autopilot controls) remains Codex-only and is hidden for Kimi sessions.

Xerj retrieval is unavailable through Mobile's supported `kimi web` path.
Although the terminal CLI accepts ad-hoc MCP configuration, web workers load
only their global MCP file and expose no native per-session connection-readiness
gate. Mobile does not materialize the conditional skill or add a tool bridge.
Profile runtimes and authentication isolation remain unchanged. This limitation
is grounded in the provider's [web command](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/cli/web.py)
and [worker MCP loading](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/web/runner/worker.py).

Kimi threads have no CLI resume command, so recent Kimi threads offer **Open**
but no **Copy**, and the session card carries a **Kimi** badge instead.

## Themes

Themes are registered once in `src/client/features/theme/theme-registry.ts`. Add a
stable ID, user-facing label, `colorScheme`, and `logoTone` there; the Appearance
control is registry-driven. The bootstrap boundary resolves storage before Svelte
mounts: `light` and `dark` migrate to the Minimal themes, while missing, malformed,
unknown, retired, and `system` values use the `dyne-org` default. Keep the
`gestalt-mobile.theme` storage key compatible and never persist a migration until a
user makes an explicit choice.

Each registry entry needs a complete semantic-token values file under
`src/client/features/theme/styles/`, including surfaces, text, borders, focus,
controls, status states, code, typography, motion, and the declared color scheme.
Components consume those shared tokens and must not branch on theme IDs. Fonts and
branding assets are bundled locally (no runtime CDN); preserve their licenses.
Keep normal text at 4.5:1 contrast and large text, icons, and control boundaries at
3:1 or better. Gestalt branding remains unchanged. Dyne.org is intentionally
light-only today; a separate light/dark mode axis requires a future product decision.
See the authoritative [Dyne.org branding](https://dyne.org/branding/) and
[Delta style reference](https://delta.dyne.org/899/).

Before adding a fourth theme, update registry/token unit tests, selector/component
coverage, and the Playwright evidence matrix in `test/e2e/theme-evidence.ts`: all
themes at 390×844/100% for each representative state, plus the named dense states at
320×568 and 768×1024 with 200% text. Verify pre-navigation storage, 44px controls,
focus/non-color state cues, no visible horizontal overflow, zero unexpected console
or request errors, and no failed local font/branding request. Dry-run the release
checks with `npm run format:check`, `npm run license:check`, `npm run check`,
`npm test`, `npm run lint`, `npm run build`, `npm run test:e2e`, and
`npm run test:package`.

## Command-line options

| Option                     | Default              | Purpose                                                            |
| -------------------------- | -------------------- | ------------------------------------------------------------------ |
| `--cwd <path>`             | Current directory    | Root containing selectable workspaces                              |
| `--host <address>`         | `127.0.0.1`          | HTTP listen address                                                |
| `--port <number>`          | `3000`               | HTTP listen port, from 1 through 65535                             |
| `--public-origin <origin>` | Loopback Vite origin | Exact browser origin for passkeys; required for non-loopback hosts |
| `--disable-passkey-auth`   | Off                  | Disable passkey access control and serve every client directly     |
| `--data-dir <path>`        | XDG state directory  | Directory containing `relay.sqlite`                                |
| `--icon <path>`            | Gestalt icons        | SVG or PNG used when installing the PWA                            |
| `--skills <profile>`       |                      | Apply a saved global profile to every session                      |
| `--skills list`            |                      | List global profiles without starting the server                   |
| `--help`                   |                      | Print usage without starting the application                       |
| `--version`                |                      | Print the installed package version                                |

`--cwd` may be relative to the directory where the command is invoked. The
resolved directory is the selectable root of a recursive workspace tree. Dot
directories are omitted, and traversal stops at each directory containing a
`.git` marker, so repositories are terminal nodes. Directory symlinks are
included only when their real target stays under the resolved root; repeated
real targets and cycles are omitted. Browser requests select nodes by opaque ID,
while real filesystem paths remain server-side.

## Passkey deployment and operating limits

Gestalt Mobile has built-in passkey authentication, but does **not** terminate
TLS. `--public-origin` must be the exact origin the browser uses, including its
external HTTPS scheme and port. `http://localhost` is the development-only
exception; every other browser origin must be HTTPS. For example, a local
developer may use `--public-origin http://localhost:3000`, while a deployed
relay may listen locally on `127.0.0.1:3000` behind
`https://relay.example.org` with `--public-origin https://relay.example.org`.

For mobile or network use, put a trusted HTTPS reverse proxy or tunnel in front
of the relay. It must preserve the external host and origin, cookies, and
WebSocket upgrade; do not mount the relay below a rewritten path prefix. Same
hostname processes may use different ports and share authorization (for example,
two local relay processes behind `https://relay.example.org`), but an RP-ID/
hostname change is refused once credentials exist because it would strand those
credentials. Do not expose `--host 0.0.0.0` before that boundary is in place.

An empty authorization store is deliberately bootstrap-open: the first verified passkey becomes the owner. Register a device before exposing the service. The
final authorized device cannot be deleted; synced passkeys can represent more
than one physical device, and an enrollment QR/link is neither recovery nor
proof of physical proximity.

`--disable-passkey-auth` restores the unprotected serving behavior from before
passkey authentication was added. It does not create or consult passkey state,
and `--public-origin` is not required even for a non-loopback listener. This is
an explicit unsafe mode: anyone who can reach the HTTP or WebSocket listener has
full access to workspaces, Codex sessions, and Git operations. Use it only on a
trusted, access-controlled local environment; never expose that mode directly
to a shared or public network. Startup prints a warning whenever it is active.

## Persistent state

With `--data-dir <path>`, state is stored in `<path>/relay.sqlite`; a relative
path is resolved from the command's working directory. Without it, state is
stored below `$XDG_STATE_HOME/gestalt-mobile/<workspace-hash>/relay.sqlite`, or
`~/.local/state/gestalt-mobile/<workspace-hash>/relay.sqlite` when
`XDG_STATE_HOME` is unset. A matching legacy `codex-relay` database is reused
when present.

Authorization is separate shared state at
`~/.codex-gestalt/gestalt-mobile/auth.sqlite` (under the selected home). Its
directory is created owner-only (`0700`); treat the database as sensitive and
keep it accessible only to the local relay user. Back up `auth.sqlite`
with `auth.sqlite-wal` and `auth.sqlite-shm` only after **all** instances are
stopped, or use SQLite backup tooling.

Kimi provider state lives apart from both: gestalt-owned `kimi web` servers
keep their isolated per-profile state under
`~/.codex-gestalt/gestalt-mobile/kimi/`, with authentication symlinked from
`~/.kimi-code`. Relay SQLite state never holds kimi credentials or chat state.

Recovery after losing every passkey is deliberately local and manual: stop every
instance, make a backup, remove only `auth.sqlite` and its `-wal`/`-shm`
sidecars, restart into visibly open bootstrap mode, and immediately enroll a new
device before exposing the service. This discards authorization, device, and
session state only—not workspace relay databases or history—and is dangerous
while the service is exposed. There is intentionally no hosted service,
federation, remote administrator, recovery code, credential export,
authentication audit analytics, attestation trust policy, or automatic reset.

For the protocol requirements behind these limits, see the official
[SimpleWebAuthn server guide](https://simplewebauthn.dev/docs/packages/server),
[SimpleWebAuthn passkey guidance](https://simplewebauthn.dev/docs/advanced/passkeys/),
[MDN passkey guide](https://developer.mozilla.org/en-US/docs/Web/Security/Authentication/Passkeys),
and [W3C WebAuthn RP ID, origin, and challenge requirements](https://www.w3.org/TR/webauthn-3/).

## Sessions

The Sessions tab uses the recursive filesystem tree to choose the base directory
for a new session. Expand or collapse folders with the disclosure buttons, or
use Left/Right while a tree item is focused. Up/Down, Home, and End move through
visible items; Enter or Space selects the focused directory. The selected path
remains highlighted when branches are folded or the catalog is refreshed.

At startup, Gestalt Mobile asks the installed Codex app-server for its available
models, and each running kimi web server for the Kimi catalog. New sessions use
`gpt-5.6-terra` by default for Codex; choose another discovered model from the
Session tab before creating the session. The default is defined
centrally as `DEFAULT_SESSION_MODEL` in `src/server/features/sessions/application/start-settings.ts`
so it can be changed in a future configuration surface. The selected model is
stored with the relay session and shown in managed session entries; in chat,
`/model` lists only models of the session's own provider.

New Codex sessions select the `workspace-git` permission profile by default.
The Gestalt manager installs that named profile in `~/.codex-gestalt/config.toml`;
Mobile passes the selection to app-server as `permissions: "workspace-git"`,
which keeps Git metadata writable without selecting full host access. Other
legacy sandbox choices remain available in the session form. The approval
policy defaults to **Approve everything** (`never`) for new sessions. On the
first startup after upgrading, saved sessions that still use the former
default pair (`workspace-write` with `on-request`) are migrated to the new
defaults. Other explicit policy combinations are preserved.

Use **Open** to relaunch a released, stopped, or attention-required
relay session from the browser.

If an upgrade has removed the Codex rollout for a saved session, **Open** keeps
the relay session and its settings but creates and binds a replacement Codex
thread. The client shows that the earlier Codex history is unavailable; other
restore failures leave the saved thread unchanged so Open can be retried.

The relay keeps SQLite state under the supplied data directory, or
under the root-hashed XDG state directory when `--data-dir` is
omitted. Active durable threads are resumed after a relay restart. A
failed child process is retried with bounded backoff before the
session is marked as requiring attention.

## Mobile recovery

The browser stores the selected session, its replay cursor, and per-session
composer drafts. On a dropped connection it replays retained events; if the
server has pruned the gap, it reloads canonical Codex thread history.

Org-plan attachments are saved with the session in the relay's SQLite database,
including their canonical path and attached state. Explicit plan attachment also
publishes a session-private status file, so helper updates and manual attachments
share the same live tracking. On restart, the relay reloads the current plan and
its progress without starting a Codex writer. Open and saved sessions show **Org
plan attached** and provide **Copy CLI** directly in their action column. Closing
a completed plan clears its attached state while retaining its last-used name.

## File previews

Plan descriptions preserve line breaks and open file or directory references enclosed
in `=equal signs=` in a shared read-only viewer only after a batched metadata check
confirms the path exists. Missing or unchecked references remain inline code. Relative catalog references resolve
from the project directory containing `.gestalt`; session plan references resolve
from the session workspace. Absolute references must remain inside that workspace.
The Git file browser uses the same viewer through its **View** action.

The viewer formats JSON and Markdown, offers the original source, and browses folders
with the existing lazy-loading tree. JSON starts with the first level visible and nested
branches folded; the Folded/Unfolded control toggles all branches, and +/− controls
expand or collapse individual branches. Other UTF-8 text files remain readable as text.
Previews are limited to 1 MiB and do not follow symbolic links. Markdown previews
sanitize markup and do not load embedded images.

## Git

The Git tab has its own filesystem-tree selection, independent from the base
directory selected in Sessions. Selecting a repository shows its branch
divergence, dirty counts, recent commits, and repository actions even when no
relay session exists. Selecting an ordinary directory makes it the destination
for Clone; repositories cannot be clone destinations. After a successful clone,
the catalog refreshes and selects the new repository without changing the
Sessions selection.

Pull uses `git pull --rebase`. Push is available only for a branch that has an
upstream, is ahead, and is not behind; it never creates an upstream or
force-pushes.

Operation results appear as non-modal notifications. Errors are announced
assertively, successful operations politely, and each notification can be
dismissed with its keyboard-accessible close button.

## Versions and upgrades

When started with `gestalt mobile`, choose **Upgrade** in the header configuration
menu and confirm **Upgrade and restart**. Mobile schedules the manager's detached
`gestalt update-restart` worker, which runs the normal `gestalt update` flow and
restarts Mobile with its saved launch options after a successful update. Running
session processes are interrupted during the restart; saved sessions remain.
The page waits for the new server instance and reloads automatically.

An update failure leaves the existing server running and appears through the
notification system. Inspect `$GESTALT_HOME/update-restart.log` (normally
`~/.gestalt/update-restart.log`) for details. Standalone `gestalt-mobile` launches
have no managed restart descriptor; use the installation commands below instead.

Inspect the executable and registry versions with:

```sh
gestalt-mobile --version
npm view gestalt-mobile version
```

`npx --yes gestalt-mobile@latest` fetches the current release according to npm's
cache rules. Upgrade a global installation with:

```sh
npm install --global gestalt-mobile@latest
```

If startup reports an incompatible Codex protocol, upgrade Gestalt Mobile or
install the Codex CLI version supported by that release. If session startup
fails, first confirm `codex --version` works in the same shell and that Codex is
authenticated. Use `gestalt-mobile --help` to diagnose rejected options without
starting the server.

From a source checkout, maintainers can exercise the installed isolated
`gestalt` profile without touching their normal relay data:

```sh
npm run test:open-profile-smoke
```

The opt-in smoke derives the selected profile's CLI version, creates a
temporary workspace and relay database, then checks normal Open and
missing-rollout replacement. It creates one bounded harmless turn to establish
durable history, deletes only the exact smoke-created Codex threads through the
app-server afterwards, and always removes its temporary state. It reports
`SKIP` when the isolated profile is unavailable.

## Control-plane traces

When an existing Chat is selected, the header menu offers **DEBUG**. Its confirmation shows the source session's live identifiers and installed component versions. Confirming captures a redacted JSON trace immediately, then makes a bounded attempt to obtain structural diagnostic observations from the source agent; an unavailable source agent does not block the investigation.

Self DEBUG starts an independent root thread in `~/.gestalt/self-debug`, using the source session's configured Org executor settings, saved executor defaults, or the installed `org-plan-executor` profile. The workspace reuses existing clones of `dyne/gestalt`, `dyne/gestalt-mobile`, and `dyne/gestalt-agents`, or clones missing repositories. Existing clones are never reset or updated automatically. Source agents get up to two seconds to accept the diagnostic request and eight seconds to write a structured response.

The Sessions tab retains a **Self DEBUG** section with source identifiers, versions, and a JSON preview link. The diagnostic agent is instructed to ask for missing reproduction details, investigate and test a fix, then request confirmation before opening a pull request or issue through authorized GitHub access. Trace exports retain at most the latest 5,000 structural control-plane events and omit free-form conversation and sensitive payload fields.

Export the durable Org Plan, Autopilot, and agent-projection timeline for one relay session without starting the server:

```sh
gestalt-mobile trace <session-id>
gestalt-mobile trace <session-id> --json
```

Use `--cwd <workspace>` to select another workspace state database, or `--data-dir <directory>` when the server uses an explicit data directory. The export excludes chat messages, prompts, model output, and environment values. New checkpoint handoffs share a stable `traceId` across checkpoint persistence, continuation scheduling, control dispatch, turn outcome, and agent projection events. The human format includes bounded diagnoses for missing transitions; JSON is suitable for issue attachments and automated analysis.

Browser receipt is intentionally not inferred from server persistence. A trace that contains `agent.activity.updated` proves the backend projection was journaled, while its diagnostic notes that the browser event cursor is still needed to prove delivery.

## Run from source

```sh
npm ci
npm run build
npm start -- --cwd <relay-root>
```

## Development

Run `npm run check`, `npm test`, `npm run lint`, and `npm run build`.

### Test lanes

Pull requests and pushes to `main` run Quality, the full Vitest suite, and Package
smoke. Package smoke includes a production build, so CI does not build it again
in a separate job. New commits cancel superseded PR runs; main release runs are
not cancelled.

Playwright functional shards, real authentication, visual evidence, and
authorization stress run weekly (Monday 03:23 UTC) or through **Actions → CI → Run
workflow**. They do not gate ordinary PRs or releases. Browser regressions can
therefore be detected later; run the relevant browser suite locally when changing
browser behavior.

These choices follow successful CI run `37347775035`: browser jobs consumed
483 of 652 total pre-release runner seconds. Removing them from ordinary runs
and removing the redundant 18-second Build job leaves a 153-second baseline
across three jobs instead of nine. These are measured runner durations, not a
guarantee about elapsed time or GitHub's runner allocation queue. The full Vitest
job took 77 seconds and remains in the default gate.

Local aggregate commands remain unchanged: `npm test` runs every Vitest test and
`npm run test:e2e` runs every browser test except the isolated real-auth journey.

- `npm run test:vitest` — all Vitest tests.
- `npm run test:coverage` — all Vitest tests with a V8 JSON summary at
  `coverage/vitest/coverage-summary.json` (the generated directory is ignored).
- `npm run test:e2e:functional` — browser-functional specs, including checks in
  visual-evidence files, excluding the real-auth journey.
- `npm run test:e2e:evidence` — the exhaustive visual/responsive evidence files.
- `npm run test:auth:stress` — the existing multi-process authorization contention
  repetitions.
- `npm run test:e2e:real-auth` — the serial real SimpleWebAuthn browser journey.

Run `npm run test:lanes` to list every lane and fail if a current Vitest or
Playwright spec is unassigned. The evidence files can overlap the aggregate
browser command while lane separation is introduced; no assertions are removed.

Maintainers should follow the [npm release operations guide](docs/releasing.md)
when configuring GitHub, rotating credentials, or recovering a partial release.

## Copyright and license

Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>

SPDX-License-Identifier: AGPL-3.0-or-later

Gestalt Mobile is distributed under the GNU Affero General Public License
version 3 or, at your option, any later version. See [LICENSE](LICENSE).

Use `--xerj manual` (default, retrieval only), `--xerj auto` (opt-in indexing), or `--xerj off`.
See [root-wide XERJ discovery](docs/xerj.md) for background indexing, exclusions,
status, recovery and the retrieval/write-permission boundary.
