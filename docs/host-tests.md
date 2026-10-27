# Host-owned test runner

Gestalt Mobile can own test processes independently of an agent's shell sandbox.
This allows integration tests to create their normal Codex sandbox without adding
an outer agent sandbox. The host process must itself run in a suitable environment;
this API does not escape a sandbox surrounding Mobile, repair Codex, or disable
Serena's permission enforcement.

## Operator setup

The runner is disabled unless Mobile starts with `--test-runner-config PATH`.
Fingerprinting requires `/usr/bin/git`; it does not resolve Git through a
potentially repository-controlled PATH.
Create that configuration as a private, user-owned file (mode `0600`) outside the
workspace, for example `~/.config/gestalt/host-tests.json`. Do not put it in the
repository or make it writable through agent workspace access. Paths below are
examples; use the actual absolute executable and checkout paths on your host.

```json
{
  "version": 1,
  "suites": [
    {
      "id": "manager-full",
      "repository": "/work/gestalt-playwright-mcp",
      "command": "/usr/bin/npm",
      "args": ["test"],
      "candidate": null,
      "timeoutMs": 600000,
      "maxOutputBytes": 8388608
    }
  ]
}
```

Start Mobile from your normal host environment, preserving your other options:

```bash
gestalt-mobile --cwd /work \
  --test-runner-config "$HOME/.config/gestalt/host-tests.json"
```

The relay data directory must also be outside the agent workspace when the runner
is enabled, so an agent cannot rewrite retained evidence. The default host state
directory meets this requirement; a workspace-local development `--data-dir`
does not. Keep the operator configuration and data directory outside any additional
agent-writable roots as well.

With `candidate: null`, the supervisor can inspect the checkout but cannot run it.
After reviewing the checkout and command, copy the digest returned by `inspect`
into `candidate` and restart Mobile to load that authorization. Configuration is
loaded once; editing a repository or an Org Plan cannot enable host execution.
Changed candidates require a new operator authorization. Unchanged candidates may
be rerun, so this is not a single-use authorization.

This authorizes execution of repository code as the host user. A named `npm test`
still executes scripts and dependencies; the name is not a security boundary.
Use only trusted code and trusted dependencies, or run Mobile's test environment
in a separately provisioned VM/container that supports the required sandbox.
No provider credentials or relay control tokens are forwarded. The runner forwards
only PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TZ and TMPDIR, plus CI=1 and NO_COLOR=1.
Tests still have the host user's filesystem access, including files under HOME.

## Supervisor API

Codex sessions expose `gestalt_test_runner`. The host accepts only requests bound
to the session's root thread; child and unknown callers cannot start or inspect
runs. Kimi does not use this API. The session workspace must contain the configured
repository. No request accepts a command, executable, working directory, environment,
or another session's identity.

```json
{ "operation": "list" }
{ "operation": "inspect", "suite": "manager-full" }
```

After the operator authorizes the reported digest:

```json
{
  "operation": "start",
  "suite": "manager-full",
  "candidate": "<64-character digest from inspect>",
  "requestId": "<new UUID>"
}
```

The response contains a `runId`. Reuse the same `requestId` when retrying a lost
start response; it returns the existing run, including after a host restart.
Reusing it for another candidate is rejected. A fresh UUID requests a fresh run.

```json
{ "operation": "status", "runId": "<returned UUID>" }
{ "operation": "cancel", "runId": "<returned UUID>" }
```

Start returns promptly. Status and cancellation are session-scoped. Cancellation
is asynchronous: poll status until it is terminal. For supervised long work use
the existing version-2 wait lease with `processResultAvailable`/`processExited`;
completion publishes a host process observation without enabling Autopilot or
clearing attention. If the run completes before a lease is registered, status
already contains the result; do not assume a future wake is still needed.

The runner permits two concurrent repositories and one run per repository. It
caps runtime at one hour and each log at 16 MiB. Session closure and host shutdown
cancel owned jobs. A guardian lifetime pipe also tears down the owned process
group when Mobile dies; deliberate descendants that escape the group are outside
this lifecycle guarantee. This process ownership mechanism is not an OS sandbox.

## Evidence and limitations

Private artifacts live under the relay data directory's `host-test-runs/<runId>`:

- `invocation.json`: configured command/arguments, repository, candidate,
  limits and runtime identity.
- `output.log`: bounded stdout/stderr, never included in the tool response or
  relay event log. Test output may contain sensitive data; access and share it
  accordingly.
- `result.json`: state, exit code/signal, candidate digests, optional TAP counts,
  log digest and UTC timestamps.

`processExitedAt` is when the host receives the guardian's test-exit observation;
it is not an upstream timestamp or an exact kernel exit time. `observedAt` is the
final result observation after cleanup and candidate verification. A successful
status is published only after that result is written. Restart converts retained
running records to `interrupted`, never success, and never signals persisted PIDs.
The runner stops accepting new jobs at 1,000 retained results; archive evidence
while the host is stopped rather than deleting artifacts during review.

Candidate version 1 binds HEAD, branch, index, and Git-visible tracked/untracked
file contents and modes. Submodules and escaping symlinks are rejected. Ignored
dependencies, environment, toolchain contents, and external services are **not**
covered. The live checkout is checked before and after execution, not snapshotted:
keep the writer idle until completion. Changes detected afterward produce
`invalidated`, even when the test exits zero; edits reverted during a run cannot
be detected by this two-point check.

`passed` means the configured command exited zero and its candidate stayed the
same. It does not accept an Org milestone. TAP counts are reported only when a
small complete output has one consistent summary; other formats and mixed output
return `counts: null`. Review logs for actual test identities, skips, and coverage.
Timeout, cancellation, output overflow, and interrupted evidence are never passes.
The runner does not automatically install dependencies, update browsers, commit,
or change plan state. Installing this new host version and explicitly configuring
it are required before an existing session can use the API.
