# Live Caddy adapter

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
