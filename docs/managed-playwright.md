# Managed browser access

Playwright is optional for Mobile Codex sessions. The Gestalt host owns its
stdio connection and browser descendants. Installation, profile consent,
activation, and verified tools are separate steps. Chat, Serena, and XERJ remain
usable when the browser capability is unavailable. Kimi has no managed browser
activation path.

## Install and inspect explicitly

Install the manager and compatible Gestalt Agents/Mobile releases first. With
Node 20 or newer and npm available to the operator (Mobile requires Node 24), run:

```sh
gestalt playwright install 0.0.83
gestalt playwright version
gestalt playwright doctor --json --cwd /absolute/workspace
```

The package release is pinned and checked for integrity, compatible CLI options,
and the actual standard MCP tool catalog. `gestalt playwright update [VERSION]`
is an explicit operator update: it stages and validates a release, then activates
it atomically. A failed stage preserves the current release. `gestalt update`
updates Playwright only if it is already installed. Boot, session start, resume,
readiness checks, and browser controls never install, download, update or repair
the package or Chrome. An offline existing installation can start; an offline
package update needs externally supplied package acquisition and is not an
automatic repair operation.

Chrome belongs to the operator. The manager discovers Google Chrome or Chromium
at conventional Linux locations (`/opt/google/chrome/chrome`,
`/usr/bin/google-chrome[-stable]`, `/usr/bin/chromium[-browser]`) and the Google
Chrome/Chromium applications under `/Applications` on macOS. Chrome/Chromium
must identify itself as version 120 or newer; the actual launch must also be
compatible. Inspect an explicit existing executable with:

```sh
gestalt playwright doctor --json --cwd /absolute/workspace \
  --executable-path '/absolute/path with spaces/chrome'
```

The initial managed launcher runs headless and uses the browser pipe. It has no
supported headed/headless override. `--headed`, arbitrary upstream flags,
personal-profile attachment, environment injection, and HTTP/CDP server options
are not managed control inputs. Do not add an unsupported flag to recover a
session; use the supported external Chrome path or correct the installation.

## Profile consent

In Mobile, open **Skills**, edit the desired named profile and enable **Browser
access (Playwright)**. Select that profile when creating the Codex session.
The global profile and workspace-default profile systems preserve an explicit
capability field; legacy version-1 YAML has no browser consent. A version-2
profile can contain:

```yaml
version: 2
name: browser
skills: []
capabilities:
  playwright:
    enabled: true
```

Use the profile UI for ordinary operation. Explicit selections take precedence
over project defaults. The session persists its validated capability snapshot;
resume does not reread ambient profiles to grant access. Start a new session to
apply a changed profile. Browser guidance is a conditional capability, not an
always-enabled skill selection. Installing the package, advertising a skill,
or declaring a plan requirement does not grant consent.

The CLI uses native Codex named profiles, a different format and storage system.
For native profile-v2, put this in `$CODEX_HOME/browser.config.toml` (normally
`~/.codex-gestalt/browser.config.toml` when launched through Gestalt):

```toml
[mcp_servers.gestalt-playwright]
enabled = true
```

Launch `gestalt cli -p browser -C /absolute/workspace`. No enabled setting means
off. An explicit disabled setting remains authoritative even if a plan requests
a browser. Native profile formats evolve; use the manager/CLI compatibility
reference for the installed Codex version rather than copying Mobile YAML into
Codex configuration.

An operator can specify an existing Chrome in the native managed server entry:

```toml
[mcp_servers.gestalt-playwright]
args = ["playwright", "mcp", "--executable-path", "/absolute/chrome"]
```

Mobile reads this entry as an operator override, without interpreting it as
Mobile profile consent. An explicit server disable, foreign transport/command,
unsupported environment override, or disabled browser skill leaves the managed
capability unavailable. Tool approval settings are preserved. With session
approval policy `never`, tools requiring a prompt remain denied. An operator
may explicitly configure `default_tools_approval_mode = "approve"` for a trusted
managed server; Mobile does not supply that approval automatically.

## Root controls and plan declarations

In an opted-in Mobile session the root supervisor uses
`gestalt_managed_playwright` with one of these strict inputs:

```json
{"capability":"playwright","action":"start"}
{"capability":"playwright","action":"status"}
{"capability":"playwright","action":"stop"}
```

Optional `planId` must equal the current retained L1 ID. Root/session/workspace
and physical-turn identity come from trusted host state; callers cannot supply
another session, executable, command, environment or workspace path. A child
agent cannot acquire or release the root's browser ownership.

The CLI's control uses the same tool name but its versioned inputs differ:
`{"action":"start"}`, `{"action":"status"}`, `{"action":"stop"}`. To bind an
Org requirement, the CLI root uses `{"action":"bind_plan","plan":"PLAN-ID"}`
from its discovered validated plan catalog. Do not interchange these payloads
or treat unsupported controls as successful activation.

An Org **L1** may contain:

```org
- Managed MCP :: playwright
```

Mobile derives the requirement from its current validated retained plan and
active WIP L1. Omission makes no automatic browser request. Unknown names,
duplicate fields, malformed values, and L2 declarations are rejected. The
declaration expresses a requirement, not consent, installation authority or
permission to resume paused work. Manual Off, attention, active child work and
the ordinary session fences remain authoritative.

The supported native runtime may need an owned-runtime resume to change MCP
configuration. Mobile reports `pending` with `owned-runtime-resume`, then
applies the request when an already-authorized next root turn reaches a verified
idle boundary. It preserves the root conversation and does not start a turn
itself. Unknown or active child topology defers attachment. Repeated controls
are idempotent. A pending stop still needs that boundary to detach; releasing
the session or closing Mobile tears down its owned connection directly.

Only `connected` with the expected standard tools enables matching browser
guidance. An installed package, ready Chrome, a listed skill, or a pending
request does not prove connection. Status reports bounded package/Chrome/Node
readiness, numeric versions and observation time. `unknown`, `absent`,
`unavailable`, `idle`, `pending` and `connected` retain their meanings; readiness
is the last bounded observation, not permission to use a page. Missing tools,
timeout or a failed connection removes only browser guidance. Already-delivered
instructions cannot be retroactively removed during an active turn.

## Workspace login state and ownership

CLI and Mobile use the same manager home and canonical workspace identity.
Dedicated state is under
`$GESTALT_HOME/playwright/workspaces/<sha256-of-canonical-workspace-path>/`, with
private directories and metadata. Workspace aliases share one identity;
different workspaces have separate cookies even when their basenames match.
The personal Chrome profile is never used. Do not publish this private state or
copy it into a project repository.

One browser owner may use a workspace profile at a time. A second owner receives
**browser busy** while chat remains usable. Release the first browser/session
normally, then retry from the intended opted-in session. The manager recovers a
stale lease only when both its recorded owner and process group are gone;
unknown ownership stays busy. Never kill an unrelated Chrome process or remove
live Chromium locks to recover a session.

Normal release, shutdown and package updates preserve workspace login state.
The manager closes the browser context before bounded process cleanup so Chrome
can flush persistent state; a whole-system crash or unresponsive browser cannot
guarantee a last write. Resume/fork rechecks consent and ownership rather than
creating a second browser owner. CLI threads created before compatible managed
controls remain unavailable if native resume cannot add the control schema;
start a fresh opted-in interactive CLI session for that capability.

## Host authority and release order

This is a host-owned stdio MCP, with no HTTP MCP listener or external CDP socket.
Chrome retains its own sandbox. MCP tool dispatch uses host filesystem authority
and the client's MCP approvals; agent-shell sandbox roots do not confine the
host browser's files, uploads or screenshots. Standard navigation, form,
snapshot and screenshot tools are enabled. The manager blocks arbitrary server
JavaScript/page evaluation, browser installers and page-supplied WebMCP tools.
Untrusted page content cannot authorize new actions.

Release a session's browser before removing or relocating its workspace state.
For a controlled package update, release active browser owners, run the explicit
operator update, inspect doctor/status, then start or resume the intended opted-in
session. The manager retains old package releases while a session may still own
one. Upgrade the manager contract first, then compatible Agents guidance/parser,
then Mobile/CLI consumers; enable profile consent after those components agree.

Older components fail closed. Mobile currently consumes installation/doctor
schemaVersion1/contractVersion1, validates the managed release and verifies
actual native tools. Unknown metadata/doctor contracts produce unavailable or
unknown readiness, never browser guidance. Missing conditional guidance or
unsupported native controls leave chat available and the browser unavailable.
An older plan parser may ignore an unfamiliar field for display; that cannot
authorize activation in an older consumer. Update the required component rather
than interpreting an unrecognized declaration as success. No minimum published
release number is implied by source-only feature support.

## Verification

The opt-in host integration fixture
`test/integration/playwright-mobile-runtime.test.ts` uses existing prepared
package/Chrome with a local deterministic model and page. It drives the actual
native CLI bootstrap/TUI and Mobile app-server adapter, verifies a shared cookie
before Mobile modifies the page, captures both screenshots, tests contention,
workspace isolation, restart, absent/incompatible Chrome, scoped approvals,
headless pipes, process/listener cleanup and blocked startup installers.

Its update test uses the real manager `update VERSION` lifecycle on a disposable
home. The CLI saves its login on prepared package `0.0.82`; the manager explicitly
updates to prepared real package `0.0.83`, then Mobile reads that login before
modifying the page. A filesystem-only acquisition fixture copies those existing
package bytes; integrity/help/catalog checks and atomic activation remain real.
Preparing the older package is an explicit isolated operator test step, not
session startup. This proves that version transition and login persistence; it
does not test online registry acquisition during the migration. Full Mobile
checks and browser E2E remain separate host gates.

## Manual integration tests

The installed-runtime browser test is skipped by ordinary `npm test` and CI.
Run it explicitly on Linux with Node 24, a compatible installed Codex runtime,
the matching manager checkout, and an existing Chrome executable. Prepare two
separate disposable manager homes explicitly; these commands acquire packages,
so run them only when you intend to prepare the integration environment:

```sh
GESTALT_HOME=/absolute/test-home-082 /absolute/manager/public/gestalt playwright install 0.0.82
GESTALT_HOME=/absolute/test-home-083 /absolute/manager/public/gestalt playwright install 0.0.83
```

Then, from the Mobile checkout:

```sh
RUN_MOBILE_PLAYWRIGHT=1 \
GESTALT_MANAGER_BIN=/absolute/manager/public/gestalt \
GESTALT_PLAYWRIGHT_REAL_HOME=/absolute/test-home-083 \
GESTALT_PLAYWRIGHT_UPGRADE_FROM_HOME=/absolute/test-home-082 \
GESTALT_PLAYWRIGHT_REAL_CHROME=/absolute/path/to/chrome \
PLAYWRIGHT_EVIDENCE_DIR=/absolute/evidence-directory \
npm test -- test/integration/playwright-mobile-runtime.test.ts
```

The fixture copies the prepared homes into disposable state, uses localhost
model/page fixtures, and verifies real CLI-to-Mobile cookie persistence across
the package update. It does not download or install Chrome. Browser UI E2E and
optional GitHub workflow instructions are in the README's testing section.
