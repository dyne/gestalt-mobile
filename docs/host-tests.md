# Host-owned test runner

Gestalt Mobile enables the host-owned test runner by default. Root Codex
supervisors can run tests from source checkouts, including uncommitted work,
without a private operator configuration, manual fingerprint approval, or a
restart when suites change. No tests start automatically.

Tests run as the host user, outside the agent shell sandbox. This lets Serena
integration tests create their intended Codex sandbox without an outer agent
sandbox. The API does not escape a sandbox surrounding Mobile, repair Codex, or
disable Serena's permission enforcement. Use trusted workspaces and dependencies:
agents able to edit suite configuration can select host executables and arguments.
Host execution grants access to the host user's filesystem, including HOME.

## Runtime configuration

Start Mobile normally; no test-runner activation flag is required:

```bash
gestalt mobile --cwd "$HOME" --host 127.0.0.1 --port 3000 \
  --public-origin https://your-mobile.example
```

The root supervisor creates `.gestalt/host-tests.json` in its **session workspace**
using normal file tools. This is the selected project workspace, which may be
nested beneath the root browsed by Mobile's `--cwd`. For a session in `/work`:

```json
{
  "version": 1,
  "suites": [
    {
      "id": "manager-full",
      "repository": "/work/gestalt-playwright-mcp",
      "command": "/usr/bin/npm",
      "args": ["test"],
      "timeoutMs": 600000,
      "maxOutputBytes": 8388608
    }
  ]
}
```

Use actual absolute checkout and executable paths. A repository must be a Git
root or worktree within the session workspace. The runner reloads configuration
on each list, inspect, or new start request. A missing file means no suites;
malformed configuration fails closed. The file is bounded to 64 KiB and 32 suites;
symlink configuration files and paths escaping the workspace are rejected.
Each started run retains its resolved command and arguments. Editing configuration
affects future runs; status and cancellation remain available after file removal
or invalid edits. Keep the writer idle while its checkout is tested.

The old `--test-runner-config` option and candidate authorization fields have been
removed. To turn off host tests, start Mobile with `--disable-test-runner`.
Creating a workspace file cannot override that option.

## Supervisor API

Codex sessions expose `gestalt_test_runner`. Only the session's root thread can
use it; child, unknown, and Kimi callers are rejected. Tool arguments never accept
commands, environment, paths, or another session's identity.

```json
{ "operation": "list" }
{ "operation": "inspect", "suite": "manager-full" }
{ "operation": "start", "suite": "manager-full", "requestId": "<new UUID>" }
```

`list` and `inspect` identify the canonical source checkout. `inspect` reports an
automatically computed source fingerprint for evidence; no approval is required
and `start` does not accept a candidate fingerprint. Start returns promptly with
a `runId`. Reuse the same `requestId` only to recover the original response,
including after a restart or configuration/source change. Reusing it for a
different suite is rejected. Use a fresh UUID for a fresh run.

```json
{ "operation": "status", "runId": "<returned UUID>" }
{ "operation": "cancel", "runId": "<returned UUID>" }
```

Status and cancellation are session-scoped. Cancellation is asynchronous; inspect
status until terminal. For supervised long work use the version-2 wait lease with
`processResultAvailable` and `processExited`. Completion publishes a host process
observation without enabling Autopilot or clearing attention. Check status for
completion-before-lease races rather than assuming a future wake is needed.

## Ownership and evidence

The runner allows two concurrent repositories and one run per repository. Runtime
is capped at one hour and output at 16 MiB. Session closure and host shutdown
cancel owned jobs. A guardian lifetime pipe tears down the owned process group
when Mobile dies; descendants deliberately escaping the group are outside this
guarantee. This process ownership mechanism is not an OS sandbox.

The runner forwards only PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TZ and TMPDIR,
plus CI=1 and NO_COLOR=1. It does not forward provider credentials or relay control
tokens. Configuration can select any executable and argv, so a test name or
environment filtering is not a security boundary.

Private artifacts live in the relay data directory's `host-test-runs/<runId>`:

- `invocation.json`: resolved command, argv, repository, fingerprint, limits and runtime.
- `output.log`: bounded stdout/stderr, excluded from tool responses and event logs.
- `result.json`: terminal state, exit code/signal, initial/final fingerprints,
  optional TAP counts, log digest and UTC observations.

Evidence must stay outside the **session workspace** and any additional
agent-writable roots. Mobile can browse `$HOME` while sessions use project
directories beneath it. If a session itself contains the evidence directory,
requests return `evidenceInsideWorkspace`; choose a narrower session workspace or
an external private `--data-dir`. Status/cancel for existing runs remain usable.
The host enforces private evidence-directory and file permissions.

`processExitedAt` records host receipt of the guardian's exit observation, not an
upstream timestamp or exact kernel exit time. `observedAt` is the final observation
after cleanup and source verification. Restart marks abandoned runs `interrupted`,
never successful, and never signals stored PIDs. Archive evidence while the host
is stopped after 1,000 retained results.

Fingerprints automatically bind HEAD, branch, index, Git-visible tracked/untracked
file contents and modes. `/usr/bin/git` is required. Submodules and escaping source
symlinks are unsupported. Ignored dependencies, environment, toolchains and external
services are not covered. Before/after checks are not snapshots and cannot detect
edits reverted during execution. Detected source changes produce `invalidated`
even when the command exits zero.

`passed` means the command exited zero and its source fingerprint stayed unchanged;
it does not accept an Org milestone. Mixed, large, or unsupported reporter output
returns `counts: null`; inspect logs for test identities, skips and coverage.
Timeout, cancellation, overflow and interrupted evidence never count as passes.
The runner does not install dependencies, update browsers, commit, or change plans.
Deploy this host version and restart before relying on the new behavior; source
implementation alone does not activate an already running host.
