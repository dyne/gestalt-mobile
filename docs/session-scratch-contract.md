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
Stop/release keeps scratch. Forget first stops and releases owned work before
targeted cleanup and durable roster retirement. Protected or indeterminate scratch
may be retained after retirement; this grants no additional deletion authority.
Resuming forgotten history requires a new allocation. Allocation/association APIs
grant no deletion authority. Clean TMP must skip unknown versions, links, foreign
owners, indeterminate leases and unregistered/ambiguous contents. Never sweep
arbitrary tmp siblings. Legacy recognition requires separate positive provenance.

## Cleanup storage and fencing

Mobile allocation and association claim the same private `.controller-lock`
directory used by CLI controllers. Mobile service allocation holds it for the
service lifetime and removes it only after release publication; active, malformed
or unknown borrower leases prevent release. An existing fence is busy, including
after a crash. No timestamp or PID permits stealing it. Concurrent allocation
fails visibly and can be retried; it never repairs an unmarked collision.

Cleanup takes an absent fence before validating the marker, every lease, and
filesystem provenance. It then reads the durable roster again under that claim.
Every roster state protects its owner, including old stopped/released entries;
history outside that roster does not. Multiple instances sharing the durable
repository observe committed roster changes before lazy runtime restoration.
Workspace locators are backfilled and retained after roster deletion, alongside
the existing canonical workspace catalog. Locators grant no deletion authority.

Before removal, an eligible owner is atomically renamed within the private
sessions container to `.cleanup-<ownerId>-<UUID>`. This registered removal
namespace prevents a new allocation at the stable owner path from entering a
deletion in progress. Payload is removed before authority metadata. A payload
deletion failure releases this invocation's fence and permits a later validated
retry. Crashes with a held fence or incomplete metadata stay indeterminate and
are retained; a directory name alone never authorizes their removal. Restored
roster protection covers both stable owners and their pending removal directories.
Cleanup skips any owner containing symlinks, foreign UID, hard-linked files,
special files, invalid metadata or unreleased/unknown leases. It returns fixed
category counts without exposing paths or contents. One unavailable workspace
does not prevent cleanup of another available workspace.

### Contained workspace and owner protection

Mobile and Launcher share the private, bare 0700 `.containment-lock` namespace.
Before publishing a new selected-workspace association or allocating a nested
owner, Mobile claims attributed managed ancestors outermost first. Cleanup also
claims its current owner, before its controller fence. Directory identity and
immutable marker provenance are revalidated under the claims; open directory
handles prevent releasing a replacement fence. Release runs in reverse order.
Busy, unknown or crashed claims are never stolen using age or PID information.
These short publication guards do not span a provider/service lifetime or alter
the existing controller and association fence rules.

New session creation and history promotion publish their durable association
before releasing the guard. Ordinary selected directories remain supported;
contention or indeterminate ancestry fails visibly and can be retried. A missing
or replaced selected workspace is not recreated by allocation. This protocol
matches Launcher `5f36e7abe81cabd29ad9e14d6b3e0a698199c025`.

Detached readable history may be opened after its historical workspace has been
deleted. History promotion observes the nearest existing canonical directory
without requiring ownership of ordinary system ancestors such as `/`. It still
claims every managed ancestor in the full historical path, including reserved
owner segments beyond a missing intermediate directory; absent, retired or
unattributed owners fail closed. The existing prefix identity and missing
frontier are revalidated under those fences before publishing the roster row.
This read-only import never recreates the workspace, allocates scratch or resumes
the provider thread. Start, allocation and cleanup retain their existence checks;
a later resume still requires a valid selected workspace.

Under these fences cleanup rereads the full authoritative roster, protecting
both contained selected-workspace paths and their scratch paths, including the
logical path of an owner already in its removal namespace. Targeted Forget uses
the same roster and excludes only its exact authorized target. Another protected
workspace keeps the outer owner's files intact. After runtime release, Forget may
retire the outer roster entry with `scratchRetained: true`; the inner roster and
its workspace remain protected.

Nested ownership markers, leases/fences and indeterminate nested `tmp/sessions`
namespaces are retained conservatively, including empty nested containers. An
outer cleanup does not recursively retire another workspace's namespace.
Inspection stops with a retained outcome above 128 levels or 100,000 entries;
these bounds grant no deletion authority. Unrelated eligible owners still clean.
Payload and marker retirement precede release of the cleanup invocation's own
fences; the empty retired directory is then removed without recursive deletion
of a fence or replacement namespace.

Earlier Mobile v1 allocations use the same validated marker and roster authority;
the compatibility fixture executes their actual historical allocator. Older
unmarked tool families lack a session-directory binding and release authority.
They remain untouched and are counted as ambiguous candidates when found directly
under a known workspace's `tmp`. See [legacy provenance](legacy-scratch-provenance.md)
for the producer revisions and limits. No general prefix sweep is permitted.

## Clean TMP API

`POST /api/maintenance/clean-tmp` accepts an empty body and no query options under
the existing passkey and exact-origin policy. It scans all durable known workspace
associations and catalog workspaces, deduplicating canonical aliases. A failure
in one discovery source preserves the other source's scope and reports a partial
result; it cannot claim that an unknown workspace was scanned.

Cleanup catalog discovery prunes positively validated managed owner directories
and their payload subtrees. These are scratch, not additional workspace targets
that can disappear during the same cleanup. It shares the canonical/private
filesystem and owner-marker validation with cleanup; names alone do not exclude
a directory. Ordinary and ambiguous nested directories remain discoverable.
Workspace selection browsing is unchanged. Durable selected workspace paths and
the current roster remain independent discovery sources, including an explicitly
selected path inside a managed owner.

The typed response contains fixed removed/skipped/failed folder counts,
cleaned/removed/skipped/failed/unavailable workspace counts, and fixed reason
counts. A workspace with a removal can also have skipped or failed candidates.
`cleaned` means its scan completed without skipped or failed candidates. Discovery
failures contribute to the unavailable reason without inventing folder or
workspace counts. Partial/inaccessible results remain distinct from complete
scans. Paths, directory listings and filesystem diagnostics are never returned.
Missing cleanup support or an unexpected operation failure returns a bounded 503;
the response is not cached. The configuration menu's **Clean TMP** action calls
this endpoint without a path or workspace option. The backend's complete durable
discovery scope applies regardless of the selected browser session or tab.

### Menu feedback and component responsibilities

Clean TMP remains labeled exactly that while pending, with a disabled button and
the status “Cleaning temporary files…”. Repeated activation joins no new request.
Other sessions remain usable. Upgrade and Quit are unavailable from the menu
during cleanup; cleanup is unavailable while those maintenance operations run.
No extra confirmation dialog is required. The native menu can be closed while
the request runs; a completion never takes focus away from another session.

Shared notifications distinguish complete, empty, protected-only and partial
results. Protected folders are a subset of skipped folders; the UI reports other
skips separately. Removed workspace counts mean workspaces with actual removals,
not the sum of overlapping cleaned/skipped/failed categories. A partial outcome
keeps successful removal counts and reports failed folders and unavailable
workspaces. Discovery-only failures may have no known workspace count, so the
notification states that some locations could not be checked without inventing a
count. Request errors make no removal claim. Partial and request failures use the
shared error toast with retry guidance; completed results use the success toast.
Notifications remain available in the existing notification history.

| Component                                             | Allocation and execution responsibility                                                                                                                                                       | Cleanup authority and limits                                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile                                                | Canonical selected workspace, stable relay owner, explicit provider associations; durable workspace locators and roster; process/service leases                                               | Clean TMP scans all durable/catalog workspaces under fences. Every roster state protects its owner. Forget releases actual owned work before attributed deletion and roster retirement.                                                       |
| Launcher (`5f36e7abe81cabd29ad9e14d6b3e0a698199c025`) | Validates inherited Mobile context; allocates standalone CLI/service UUID owners and publishes leases before native work; forwards context to managed children and scrubs unrelated discovery | Releases only proven stopped consumers; unknown/crashed leases stay protected. Allocation, borrower metadata and a prefix alone never grant deletion authority. See Launcher `docs/session-scratch.md`.                                       |
| Agents (`c159a5a181a05971532efa734f4d9cd7dcec88cc`)   | Validates the same context; generated scripts and transient execution use isolated `.ctx-mode-*` children inside that owner; foreground completion removes only its invocation child          | Does not allocate or retire session ownership. Background/crash leftovers remain attributed to their owner until authoritative cleanup. Persistent context-mode state keeps its existing storage rules. See Agents `docs/session-scratch.md`. |

Standalone execution without a context retains its documented operator/OS
fallback; a present invalid context fails visibly rather than falling back.
Destination-local atomic install staging, dependency/runtime installations and
provider state remain persistent or transaction-owned. This contract does not
grant cleanup authority over them. Verified earlier Mobile v1 allocations use
the same marker validation; unmarked historical tool prefixes remain ambiguous
retained candidates as documented in [legacy provenance](legacy-scratch-provenance.md).

## Durable Forget operations

`DELETE /api/sessions/:id` uses a dedicated operation, independent of Stop and
release. Its fixed metadata contains `operationId`, `sessionId`, `phase` and
`updatedAt`, plus a bounded `failureCode` on failure and optional
`scratchRetained: true` when cleanup preserves files. Phases are `stopping`,
`cleaning`, `finalizing`, `failed`, and `completed`. The roster's list/get read
models include `forgetOperation`; `session.forget.updated` events publish the
same typed metadata while the frame exists. No percentage is inferred.

The operation row is a durable business fence across server instances sharing
the database. Session mutations and scratch allocation reject a fenced owner;
SQLite prevents a late save from overwriting or recreating the roster row.
Same-process requests join one promise; cross-process requests/retries use the
same operation ID. Startup retries unfinished operations without assuming the
prior runtime died. It re-enters resource release before attempting deletion.
Unknown crashed controller fences or process leases remain protected, including
on restart. They retain files without preventing roster retirement after confirmed
runtime release, and never authorize stealing a lock or expiring a lease.

Mobile-owned Codex resources and host-test guardians publish individual process
leases before launch. Normal exit releases only the exact claim after confirmed
process-group absence; termination delivery alone is insufficient. Forget waits
for host-test cancellation and starting/closing runtime resources, uses existing
native controls for known detached child claims, and requires confirmed runtime
release. Unknown claims from another server retain their owner until that owner
confirms release. Kimi commands use shared service scratch: Forget aborts only
that session's known prompts, verifies the provider's inactive status and releases
its subscription; other sessions keep the shared service. Persistent provider
history, auth and profiles are never removed.

Cleanup targets only the session's validated managed owner/removal directories,
under its durable operation's authority. A successful request returns 204 after
cleanup and atomic roster/operation finalization. Protected, busy, uncertain or
nested owners retain their files and record `scratchRetained: true` durably.
Known workspace locators survive retirement, so later Clean TMP still discovers
retained files and rechecks their leases, metadata, nesting and current roster.
Unsafe paths and I/O failures still fail cleanup. Failure returns 503 with
`SESSION_FORGET_FAILED` and operation metadata, retaining the roster and original
thread identity for recovery/retry. Repeated completed requests remain idempotent.
Promoting forgotten provider history creates a new relay identity and fresh
scratch. Filesystem deletion and SQLite finalization are separate failure domains;
no cross-resource transaction is claimed. The Sessions and roster/sidebar frames
render this durable operation with an indeterminate status and conflicting owner
controls disabled. A frame stays visible until confirmed successful retirement;
failure keeps it retryable and uses shared error feedback. Reconnect and reload
rehydrate the operation from backend list/get/bootstrap models, independent of
the original request or socket lifetime.

The roster write fence also blocks updates to its cached event sequence. Journal
allocation therefore uses the greater of that counter and the durable journal
tail plus one. Failure and retry events keep distinct replay sequences, including
for sessions whose counter was already frozen by an earlier release. The fence
continues to reject late state saves and completed-session resurrection.
