# Session scratch contract (version 1)

This contract is shared by Mobile, the Gestalt launcher and Agents. Scratch is
disposable; source, Git state, history, plans, authentication, installations,
dependency caches, browser profiles, Serena/XERJ indexes and context-mode databases
retain their existing persistence rules. Version mismatches fail visibly.

## Location and identity

Use the owning session's selected **canonical absolute workspace**, never a
command's changing cwd. Mobile allocates
`<workspace>/tmp/sessions/mobile-<sha256(UTF-8 relay session ID)>/`.
The relay identity is durable and independent of provider thread IDs. Restart,
recovery and reopen reuse this owner. Each workspace has its own namespace.
IDs accept 1–256 ASCII letters, digits, `_`, `.`, `:`, `-`, starting with a letter
or digit. Traversal and relative workspaces fail before allocation. Symlinked
workspace aliases, tmp roots, containers, owners and markers are rejected.

Managed containers/owner directories have mode 0700 and markers 0600. Existing
user tmp siblings and permissions are preserved. A managed-container `.gitignore`
containing `*` ignores generated contents, including itself; existing rules are
never replaced. Unmarked collisions, corrupt/foreign markers and nonprivate
owners fail visibly. There is no fallback to `/tmp` or another owner's bucket.
An allocation interrupted before a valid marker is written remains indeterminate;
it is never automatically adopted or deleted. OS mount restrictions still apply;
the filesystem allocation test executes a generated 0700 command.

## Environment and marker

Export `TMPDIR`, `TMP` and `TEMP` equal to the owner directory, and exactly one
additional context variable, `GESTALT_SESSION_TMP_CONTEXT`, containing JSON:

```json
{
  "schemaVersion": 1,
  "workspacePath": "/work/root",
  "ownerId": "mobile-<64 lowercase hex>",
  "directory": "/work/root/tmp/sessions/mobile-<64 lowercase hex>",
  "markerPath": "/work/root/tmp/sessions/mobile-<64 lowercase hex>/.gestalt-owner.json"
}
```

This is a locator, not authority. Consumers validate version, canonical workspace,
direct-child containment, filesystem owner, private permissions, absence of links,
and the marker before trusting or exporting any path. Reject mismatches rather
than trusting ambient TMPDIR. Owned children/MCP/native tools inherit all four
values; unrelated discovery children scrub the context and its three temporary
variables before receiving their own appropriate environment. A present context
variable (including an empty/invalid one) marks all four values as session-owned.
When that variable is absent, preserve operator TMPDIR/TMP/TEMP values: a deliberate
executable host temporary root is not evidence of session ownership. Do not log values.

The `.gestalt-owner.json` marker contains only ownership metadata:

```json
{
  "schemaVersion": 1,
  "ownerKind": "mobile-session",
  "ownerId": "mobile-<64 lowercase hex>",
  "workspacePath": "/work/root",
  "sessionId": "relay-id",
  "createdAt": "2026-11-02T12:00:00.000Z",
  "authority": { "kind": "mobile-roster", "sessionId": "relay-id" },
  "providerThreads": [{ "provider": "codex", "threadId": "provider-thread-id" }]
}
```

`providerThreads` is an explicit association, initially empty before provider
startup. Append associations after startup/resume; never infer equality with the
relay identity. Preserve creation time. Publish marker replacements atomically in
the same owner directory. A single owning controller serializes updates; competing
controllers cannot assume a partially published allocation is theirs. No prompts,
credentials or model output belong in metadata.

## Standalone and shared owner extension

Version 1 reserves `ownerKind: "cli-session"` with owner IDs `cli-<UUID>` and
`ownerKind: "workspace-service"` with IDs `service-<UUID>`, in the same sessions
container. These use the same envelope and marker fields, with `sessionId` equal
to their stable owner ID and explicit provider associations. Their authority is
`{"kind":"lease","leaseId":"<UUID>"}`. A private `leases/<leaseId>.json` file
contains `schemaVersion: 1`, matching `ownerId`, `workspacePath`, `leaseId`,
`state: "active" | "released"`, `processIdentity` (opaque runtime instance UUID),
`createdAt`, `updatedAt`, and `consumers` (stable owner IDs). The launcher owns
allocation and durable publication of these leases. Early CLI startup gets a
stable UUID before its thread exists. No selected workspace means no managed
session allocation; report that limitation instead of selecting an arbitrary cwd.

A lease is released only after owned subprocesses stop and all consumers release.
Heartbeat age or PID absence alone never proves death. Unknown/crashed/partially
published leases are protected until explicit authoritative recovery proves
release. A shared service keeps its own owner and consumer leases, never the
first caller's directory; changing callers/workspaces cannot relocate it.

Mobile implements workspace-service allocation for shared Kimi processes and its
XERJ indexing watcher. Each gets a fresh UUID and a manager consumer identity
(`kimi-<profile>` or `xerj-indexer`). Its workspace is Mobile's configured canonical
root, independent of the requesting session's workspace/cwd. The manager releases
the consumer only after the owned process group is confirmed absent with a
signal-zero probe. Shutdown allows bounded TERM grace, then KILL and bounded
confirmation; successful signal delivery alone never authorizes release. Timeout,
permission failure, unknown group identity and unreaped zombies retain an active
protected lease. Watcher exit75 alone does not release it. An already-exited
leader permits only bounded read-only absence checks: a cached numeric group ID
never authorizes a new termination signal after leader exit. Unconfirmed shutdown
retains an indeterminate protected lease. Kimi commands share this service context because
Kimi shares a process per profile; each relay still has its own Mobile marker and
explicit provider mapping. Persistent Kimi profiles stay in their original paths.
The launcher implements CLI allocation before cleanup may recognize CLI owners.

## Lifecycle and cleanup boundary

Mobile's durable roster is its authority, covering running, open and saved/
reopenable sessions even without a runtime, browser connection or active turn.
Stop/release keeps scratch. Forget first stops and releases owned work; deletion
and truthful retryable progress are implemented by the later cleanup milestone.
Resuming forgotten history requires a new allocation. Allocation/association APIs
grant no deletion authority. Clean TMP must skip unknown versions, links, foreign
owners, indeterminate leases and unregistered/ambiguous contents. Never sweep
arbitrary tmp siblings. Legacy recognition requires separate positive provenance.
