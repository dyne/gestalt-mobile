# Live Caddy adapter

`SqliteLiveOwnership` is the authoritative shared relay/app claim store. Use one
elected controller and its private `live.sqlite` across every relay data directory;
opening another connection preserves claims. Missing, corrupt, foreign-controller
or unsupported-version state fails closed. Only explicit first provisioning may
initialize it. The elected controller calls `recoverController` after takeover;
that transaction advances epoch and generation, preserves the last external IO
intent, and moves every non-idle run to recoveryRequired. It does not release
writer reservations or claims based on timeout/process absence.

`electLiveController` constructs this shared store only after a Linux OS lock
elects one controller across independent Mobile processes. Supply one absolute,
canonical, existing user-owned mode-0700 private directory and stable controller
ID across every relay data directory. First provisioning requires explicit
`initialize: true`; missing state on restart refuses construction. The adapter
never removes the lock inode, repairs an exposed directory, or adopts unowned
IPC. Its owned lock holder exits on parent pipe closure; holder loss closes the
store and fails outstanding callbacks. Every election advances the durable epoch
and marks unresolved runs recoveryRequired while retaining writer claims. Close
the controller only after lifecycle shutdown; closing does not release Live claims.
This constructor grants no native confinement, target admission or Start readiness.

`LiveDispatchGuard` reserves ordinary writers in that same transaction store before
runtime creation, model/skill discovery or ordinary mutation endpoints can await.
The Codex RPC adapter checks every effect before sending and after its response;
the Kimi runtime checks startup, restore, prompt/steer and interaction paths.
Composition also gates auxiliary catalog/skill process launches and Kimi server
creation. Their unproved effective scopes use a durable shared auxiliary claim,
including after close, until controller-owned reconciliation proves the whole tree
quiet. Auxiliary admission coexists with ordinary session reservations so nested
or earlier discovery cannot disable ordinary work. Every Live claim still treats
it as an unknown global writer. Controller-issued auxiliary token IDs encode this
distinction in the existing private ledger; the reserved native catalog identity
also recognizes its earlier token format without removing its claim. Old readers
retain global Live exclusion. Ordinary writer scopes and exclusive ordinary-to-ordinary conflicts
remain intact. A read-only
ownership adapter grants no write admission. Provider/model and inherited native
permissions remain unchanged; Kimi Live execution remains unavailable.

Autopilot timers, queued operations, Org checkpoint/deadline recovery, capacity
recovery and agent followups consult ownership again at execution. Ordinary APIs
return `LIVE_MODE_ACTIVE` before cached prompt replay or model/control persistence.
Manual Off, nonmodel interrupt and exact read-only Org health remain reachable.
Only a trusted controller can enter a fenced Live event; it must verify native
collaboration/external-writer confinement first. That authority expires when the
event returns, including for detached callbacks. No HTTP/tool argument grants it.
Pending ordinary approvals and delayed effects remain held or reject stale fences.
Root completion, process exit and Stop never release a reservation automatically.
Prior-control restoration is a separate lifecycle step, not timer-driven expiry.

Start captures prior Autopilot intent and its durable generation before suspending
delivery. `AutopilotLiveControls` pauses timers without disabling that intent or
creating Org checkpoints. The elected controller can bind this adapter through
composition; the binding grants no Start capability. `stopLive` records fenced
cleanup intents/acks, removes owned route/auth/helper resources and verifies the
entire tree before releasing ownership. Failed or interrupted cleanup retains
`recoveryRequired`; a replacement controller must explicitly reconcile it.
Restore compares the current control version, enabled choice and current plan
identity/completion. Manual Off, replaced/removed/completed plans and newer Live
generations defeat old snapshots. A durable restoration acknowledgement and the
existing atomic Autopilot command ledger prevent duplicate continuation after
retry/restart. Read-only plan projection stays current while Live holds dispatch;
plan measurement writes, provider metadata updates and scheduling remain held.

`RegisteredDevServers` verifies the actual Linux loopback listener's socket inode,
PID start time and executable digest. It canonicalizes and rechecks app device,
inode and original registry path, including symlink retargets. Registration never
grants permission to terminate an external server. It is trusted process admission,
not a public arbitrary-port/PID API and not proof of sandbox isolation.

The `startLive` use case records fenced intent/ack phases around quiescence,
helper preparation, authorization, route activation and reverse rollback. Busy
admission never interrupts a writer. The private store also arbitrates ordinary
writer reservations against ancestor/descendant app scopes; unknown or retargeted
effective scopes are busy. Failed starts retain claims, including after cleanup,
until explicit reconciliation. Late Stop/controller callbacks cannot acknowledge
or roll back a newer revision/generation.

Production Start remains unavailable until composition supplies an elected shared
controller, production authentication, registered listener/process proof, complete
writer-tree quiescence and controller-state denial for every project/agent process
(including an existing dev server), plus the owned helper lifecycle. No Start
endpoint or capability-ready flag is provided by these adapters. The admission
port must verify those facts before any public route and again after preparation;
an unprotected pre-existing process must refuse readiness. Application orchestration
contains no filesystem/process/provider implementation and cannot widen permissions.

`CaddyRouteBroker` is a private controller boundary, not a Mobile HTTP endpoint
or an agent tool. Authenticate the controller with a random credential from
controller-private state. Its command schema permits only activate, remove and
reconcile, selecting a previously registered opaque target ID. It accepts no
admin path, proxy URL, arbitrary config, shell command or TCP admin fallback.

Register app/helper/gateway loopback ports only during trusted app admission.
Caddy always forwards both the reserved helper prefix and app root to the
authenticated gateway; it never forwards directly to either project target.
Registration must follow the gateway's authorization and reserved-prefix checks.
This package does not constitute production Start admission or readiness wiring.

Use `protectCaddyControllerState` when admitting **every** project/agent process,
then retain that exact effective managed policy for runtime execution and
`ManagedCaddyAdminBoundary`. It adds an explicit private-directory deny without
broadening inherited permissions. Place the admin socket, broker credential and
private origin database there. An existing project/dev-server process outside
that boundary cannot be declared isolated by testing a different sandbox: refuse
readiness or use an operator-provided isolated controller/broker. Do not change
the process UID, use a boolean readiness assertion, or treat mode 0600 as proof.

The verifier launches the actual same-UID project command through native Codex.
It checks direct socket and credential access plus every visible process-root
alias. The controller must still reach the live Unix admin API before and after
the check. Missing exclusions, sandbox startup failure, timeout, malformed proof,
or any successful socket connection return `LIVE_CADDY_ADMIN_UNISOLATED`. Repeat
proof after runtime/sandbox/service changes. A private mount namespace alone is
insufficient: same-UID callers can reach its socket through `/proc/<pid>/root`.

The SQLite ledger permanently assigns each canonical app root an HTTPS origin;
Stop deletes desired routes, never assignment records. Preserve the database on
restart and report capacity exhaustion. A fresh controller must re-register
targets before restoring any desired route; durable dial addresses alone are
not authorization to proxy to a reused localhost port. Startup with lost state
requires recovery, rather than allocating apparently vacant origins. Missing or
empty state fails with `LIVE_ORIGIN_STATE_MISSING`; only explicit first-time
provisioning may pass `{ initialize: true }` to the store constructor. Runtime
restart/recovery must use its default, which never creates a replacement ledger.

The route engine operates solely on recorded `gestalt_live_*` servers. It checks
ownership against its last desired/applied JSON, reads a servers-subtree ETag,
and sends `If-Match` with each scoped PUT/PATCH/DELETE. HTTP 412 triggers at most
four refreshes. Unknown ownership/listeners fail closed. Operator Caddyfile
reloads/restarts may remove routes; reconciliation recreates only durable owned
intent and preserves unrelated sites. No full config replacement is used.

Run the real Caddy fixture explicitly:

```sh
LIVE_TEST_CADDY=/path/to/caddy npx vitest run src/server/platform/live-design/caddy-routes.test.ts
```

`.github/workflows/live-caddy-proof.yml` runs that fixture and the actual native
project denial gate on a disposable supported runner, using checksum-pinned
Caddy 2.11.7 and Codex 0.161.0. It uses only temporary config/state, disables test
CA installation, authenticates scoped operations and repeats denial after
Caddy restart. The default suite also exercises durable origin and fail-closed
broker contracts without requiring an operator Caddy installation. The explicit
native proof must have no skipped tests before accepting route readiness.

`createPreviewGateway` binds a durable assigned origin and a trusted target
registration to a private loopback listener. It serves the L5 fragment/PKCE
exchange and authorizes every app/helper HTTP request and Vite WebSocket
upgrade against that binding. Upstream bodies stay streams, including helper
JSON POSTs; Mobile/preview cookies, authorization and forwarded headers never
reach the project. The owned connection registry checks every response chunk
and WebSocket message and closes both SSE and HMR on revocation. All responses
receive the frame and same-origin resource restrictions. Controller composition
must register this listener before Caddy activation; no public request can choose
its instance, origin, project root or loopback targets.
Browser WebSocket upgrades require the exact assigned Origin and lease. Browsers
omit Fetch Metadata on those upgrades; if supplied, foreign metadata is rejected.
HTTP non-navigation reads still require `Sec-Fetch-Site: same-origin` as specified
in the existing ADR.

The same disposable workflow runs `scripts/live-remote-proof.mjs` after the
focused native proof. It checksums the CI-published patched Impeccable archive,
uses its embedded Vite 8 React fixture and upstream browser UI helpers, and runs
the real helper and Vite under the verified managed policy. A separate Linux
network namespace can reach Caddy through a veth pair but cannot connect to the
helper's loopback. Only that temporary browser HOME trusts the temporary CA;
Chromium certificate checks remain enabled. Actual SimpleWebAuthn registration,
launch grant/opener PKCE exchange, overlay, helper SSE/event/reply and Vite HMR
run through the gateway. The artifact includes four screenshots at 390×844 and
1440×900, anonymous asset/upgrade denials, revocation checks, sanitized network
destinations and pinned runtime digests.
Two admitted copies of that fixture obtain distinct port-bound leases in the
same browser. Cross-port script/image/iframe and WebSocket probes send the
ambient lease cookies but receive denials; no canary script executes. Both real
helpers/dev servers use their own verified managed policy and origin binding.
The generated fixture lockfile is included for reproducing dependency resolution.
It contains no raw tokens, grant
fragments, cookies or project/helper logs. The fixture removes its namespace,
processes and temporary state. It neither deploys nor edits operator Caddy state.

`OwnedLiveHelper` owns only the checksum-pinned Impeccable process. Construct it
inside the elected controller with the admitted canonical app root, dedicated
helper port, HTTPS `/__gestalt_live/` URL, generation, controller-private state
and exact effective managed policy. `ManagedHelperLauncher` runs the native
sandbox command with that unchanged policy; it never starts another app-server
or model session. Every helper/CLI command receives copy-agent mode `chat`.
The runtime binary must remain outside project write permissions, and private
helper metadata must remain denied to every admitted project/agent process.
This adapter does not enable production Start or establish the L7 admission facts.

Readiness requires the verified executable, boot ID and process start time,
owned loopback listener, canonical cwd and authenticated
`live-status` response. Persisted upstream `server.json` alone never grants
ownership. Unknown/stale metadata fails closed; a known dead helper requires
explicit `recoverStopped` reconciliation before restart. That operation retains
stale server evidence privately and uses upstream injection-journal healing.
Config overrides change only config lookup; canonical state and session journals
remain under the app's `.impeccable/live`. `resume` and `complete` use the pinned
CLI, including its source-cleanliness gate, without `--force`.
Every CLI command explicitly targets the admitted app, so parent manifests cannot
redirect source recovery. App device/inode changes refuse further helper IO.
Direct children require launcher ancestry. The native sandbox daemon's PID
namespace requires a bounded host-process mapping by namespace PID, process birth,
verified executable, app cwd and owned listener; host and upstream PIDs remain
distinct in private metadata. Ambiguous command outcomes remain durable and block
source-side retries until controller-owned reconciliation.

Stop requests shutdown only from the identity-verified helper, then verifies
exit and runs `live-inject --remove` separately so rollback failures remain
visible. It never sends a PID-based signal or stops an external dev server.
Bounded diagnostics contain only command names, fixed outcomes and byte counts;
helper output, tokens, project content and environment values are not logged.
The controller must retain its app/relay claim until full lifecycle reconciliation,
including unresolved command/process activity, finishes.

Run the real helper fixture with `LIVE_TEST_IMPECCABLE=/path/to/pinned/impeccable
npx vitest run src/server/platform/live-design/helper-process.test.ts`. Set
`LIVE_TEST_CODEX=/path/to/pinned/codex` as well for the actual managed-policy
proof; its explicit supported-runner gate must pass without skips. The existing
isolated Caddy workflow supplies both pinned binaries and disposable-runner native
prerequisites. Direct-launch fixtures prove lifecycle behavior, not production
native confinement or overall Start readiness.

`PollLiveEvents` uses the foreground `live-poll` CLI, including upstream
preflight, its 600-second lease, accept/discard source locks and receipts,
and canonical replies/completion. It never implements HTTP `/poll` itself.
`SqliteLiveEventInbox` belongs in shared controller-private state outside the
app. One durable app-inode reservation spans status, poll, relay turn and ack.
A second process cannot take it over on timeout or process exit. Restart,
lost stdout after canonical accept, lost reply, stale fences and expired leases
retain recovery evidence and blocking ownership; reconciliation belongs to the
Stop/Resume controller. Records contain identities, digests and the durable
received/dispatched/applied/acknowledged history, without browser content or
model output. A hard 256-record default bound fails closed and retains tombstones;
controllers must explicitly reconcile completed history before capacity renewal.

The pinned IDs identify sessions rather than individual actions. Keys include
Live generation, upstream ID, event kind and a digest excluding poller-owned
preflight enrichments. Different steering requests remain distinct. An identical
steer or mount repair cannot be proved to be a new action, so it requires explicit
recovery. Duplicate edit deliveries never start another turn; known terminal
sessions are rejected before another canonical poll. Upstream accept receipts
protect repeated deterministic operations; lost or ambiguous results still
require journal/source reconciliation. This is not an exactly-once edit claim.
ID-less prefetch/timeout/exit are advisory and cause no edits or replies; the
pinned server removes ID-less queued events on lease. Exit is returned to the
lifecycle controller for cleanup, never treated as a clean release.

`RelayLiveEventTurns` sends work only to the existing owning Codex thread using
its existing runtime and session model, reasoning effort, execution policy and
skill selection. It waits for the actual turn's completion, validates the final
structured result, and bounds it by the upstream lease deadline read through
canonical status. It never reacquires a writer or launches another provider.
Composition supplies this narrow factory to the trusted controller through
`bindPollEvents`; this binding grants no readiness or production Start capability.
The L7 guard verifies native collaboration confinement before side-effecting
poll commands and each model turn, and fences every acknowledgement. All
production admission requirements remain in force. Kimi Live remains unavailable.

`LivePollLoop` serializes those iterations and cannot restart after an exit or
failure. Composition's `bindPollLoop` supplies the same owning runtime plus the
production durable preview revocation/connection barrier; it is available only
with production passkey authentication. Bind its `revoke` and `drain` methods to
Stop/Resume resources after actual admission. Disconnect/error drains revoke
preview access before cancelling commands and retain recovery ownership; Stop
owns concurrent cleanup, and late old-controller loops cannot touch successors.
This loop does not remove routes, reconcile journals or release claims itself.

Lifecycle revocation uses a monotonic per-Live generation cutoff, closes all
owned streams through that cutoff and permanently denies older leases/grants.
Resume advances generation only after journal/source/route reconciliation and
before authorization. A delayed older revocation cannot invalidate newer access;
no barrier is cleared. Whole-instance, device and authorization-session revocation
remain permanent. Gateway/helper bindings must be reconstructed for the resumed
generation and reverified before exposure.

Stop revokes durable preview access and closes owned streams before cancellation
or route removal. A stream-close failure still attempts cancellation and safe
cleanup; failed revocation never releases the claim. `PollLiveEvents.settle`
fences delayed receipts, wakes the helper's canonical foreground poll and awaits
its exit, and calls the existing owning runtime's `settleLiveWork`. That method
interrupts the root, observes a bounded native descendant tree and background
commands, terminates exact command instances, and requires idle native statuses,
no outstanding results or approvals. Unsupported observations fail closed; it
never launches a replacement runtime/history reader to manufacture settlement.
Every native cleanup request rechecks the ownership fence; a late callback cannot
continue cancelling after another controller or Stop takes over. Native observations
and waiting for a previously dispatched response have bounded cleanup budgets; an
unresponsive runtime returns an explicit recovery error. Settlement is checked again
after dispatched effects return, since a queued turn/start can materialize while its
old response is settling. Actual completed history also reconciles a delayed or
lost session completion notification before another Live turn or control restoration;
provider/model/permissions remain unchanged. A cancellation RPC acknowledgement is not proof of
completion. Retry Stop using
the current durable fence after actual work settles. Journal/source reconciliation,
canonical completion or discard, injection removal and actual route/auth/process
cleanup must all finish before ownership and prior controls are released.

The pinned server arms an eight-second timer when its last browser SSE client
disconnects. Background tab suspension and network loss use that same upstream
behavior; Gestalt adds no extended grace or keepalive that conceals a disconnected
browser. A received `exit` changes ownership to `recoveryRequired`, invalidating
preview authorization and every later edit dispatch. The helper's journal and
config remain recovery inputs. Reconnection within the upstream grace cancels its
anonymous exit; reconnection after an exit requires explicit Resume reconciliation.
Explicit Stop always fences work immediately, independent of that timer.

`resumeLive` revokes again, settles owned work, reconciles canonical journal/source
postconditions and owned routes, and repeats actual admission proof before
regranting access. A failed source, route, helper or isolation check keeps access
revoked and ownership in recoveryRequired. An idle generation cannot Resume;
Start must acquire a new claim. The private inbox's explicit reconciliation records
completed/discarded disposition plus a source/journal proof digest while preserving
original received/dispatched/applied/acknowledged history. An ambiguous applied
record never becomes an invented acknowledged record. Terminal and reconciled
tombstones cannot cause another edit; capacity remains a hard bound and fails
explicitly rather than silently deleting deduplication evidence. The controller
must obtain this proof from canonical journal/source reconciliation, never an
HTTP or model-supplied hash. `OwnedLiveHelper.reconcileJournal` inventories bounded
durable journal files as well as canonical status, because pinned `live-resume`
intentionally hides completed/discarded sessions. Lost terminal stdout cannot
therefore be reconciled from an empty active-session list. The adapter uses actual
upstream accept receipts for unfinished operations, the canonical no-force source
gate, and source/terminal-journal digests; it preserves prior terminal dispositions
and all journal entries. Explicit Stop can discard unfinished variants through
canonical `live-accept --discard`, using its source lock and durable receipt. An
accept already applied before Stop finishes its chosen source; it never receives
a conflicting discard or another accept transformation. Missing/outside/dirty sources or conflicting receipts
retain recovery. Repeated terminal acknowledgements yield the same proof digest.

Production Start remains unavailable: the CLI does not supply a production
`liveController`. The elected store, canonical poll loop, durable generation
cutoffs and Stop/Resume adapters are lifecycle foundations, not an admission
receipt for an existing process tree. The request guard cannot confine native
child/tool writers.

## Host launch foundation and remaining admission

The supported launch chain starts Mobile from the trusted host, then uses
`launchCodexAppServer` with private stdio. The app-server inherits that host
namespace; each native `command/exec` must select a trusted managed permission
profile. Launching another app-server inside an agent sandbox instead sees the
fixed `/tmp/codex-daemon-<euid>` mode-000 mask and fails its required mode-0700
check. Changing `--listen`, HOME or TMPDIR does not relocate this fixed path.
The host route avoids that nested check without removing the child's mask.

The app-server RPC transport is a controller authority boundary. Trusted
`fs/readFile` RPC has host filesystem authority; it is not equivalent to a model
file tool running with turn permissions. Do not expose unrestricted RPC to the
browser, project, helper, agent or MCP processes. Native managed tool policies
also do not automatically confine directly spawned MCP servers.

The isolated host proof used Codex 0.161.0 (source pin
`979011409de0a60b52f179721948e65531d26144`, binary SHA-256
`9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c`).
[Successful proof run 38252423273](https://github.com/dyne/gestalt-mobile/actions/runs/38252423273)
ran provisional source head `2facdae77f2b807798aa02a5d63a12d9161aebc6`.
Artifact `11749206185` has ZIP SHA-256
`1556c0e8e928a077108c9b31d2448c29a89e165a9fbb27fd1014cf247871dd46`.
It proves ordinary command/public-read success and same-UID native child denial
of disposable private controller/auth/Caddy files, the controlled Unix socket,
daemon-directory traversal and tested proc/FD aliases. The host daemon directory
was mode 0700; the child saw the read-only mode-000 mask. The controller could
reach its fixture socket before and after, no child connected, and the owned
app-server stopped. Trusted fs RPC deliberately read its private canary.

That proof used no model calls, credentials, configured MCP or production
services. Native model file tools, production config admission and the complete
dev-server/helper/MCP/collaboration descendant tree remain untested. It did not
exercise the Live picker/edit/accept lifecycle. The provisional diagnostic
workflow and probe exist on draft PR 104's test branch, not in this delivered
adapter diff. Its passing standard CI does not verify the current uncommitted
L8 tree. This repository's `live-caddy-proof.yml` retains the complete pinned
native Caddy, helper and separate-network browser gates; the diagnostic workflow
must not replace those integration gates.

| Remaining boundary                               | Required owner and proof                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted host launcher and native policy receipts | L9, Manager: protected controller/auth/Caddy paths and explicit managed policies for owned launches                                               |
| Config admission and MCP/descendant confinement  | L10, Agents: allowlisted trusted config and separately confined MCP, hooks and other subprocesses                                                 |
| Production Start and real Live lifecycle         | L11, Mobile: concrete admission, owned helper/dev server, native model tools, Caddy/auth/browser and real picker/edit/accept/Stop/Resume evidence |

Refuse unverified existing processes; do not adopt unowned daemon IPC or enable
Start from fixture readiness or callbacks. The host proof requires no Codex fork
on the demonstrated route, but does not establish complete production isolation.

Native settlement uses Codex 0.161.0's supported subagent `sourceKinds` and
bounded pagination. `ThreadListParams` has no parent-thread filter. Before
cancelling a descendant, settlement verifies its `Thread.parentThreadId` chain
and `sessionId` through the owning root using fresh `thread/read` observations;
locally observed child IDs alone grant no cancellation authority. Missing,
conflicting or unavailable lineage retains recovery ownership. Production L11
must prove this discovery against the actual owning native session tree.
