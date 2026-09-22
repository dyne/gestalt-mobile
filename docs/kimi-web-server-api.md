# Kimi web Server API — verified notes (kimi CLI 2.0.2)

Captured from a live `kimi web --no-open` instance on 2026-09-22. Checked-in
spec snapshots: `docs/kimi-web-openapi.json` (REST), `docs/kimi-web-asyncapi.json`
(WebSocket). These are ground truth for the `src/server/platform/kimi/` adapter;
where prose docs (kimi.com) disagree with these files, trust these files.

## Server lifecycle

- `kimi web --no-open --port <p>` runs the server in the foreground; busy port
  retries `+1` (up to 100). Bind defaults to `127.0.0.1`.
- **No `--skills-dir` flag on `kimi web`** (unknown option). Skills reach the
  server only via discovery or `extra_skill_dirs` in `config.toml`.
- The bearer token is printed in the startup banner (`Token: <token>` on stdout).
  `kimi web rotate-token` writes a persistent token to `<KIMI_SHARE_DIR>/server.token`.
  Instances register under `<KIMI_SHARE_DIR>/server/instances/`.
- `KIMI_SHARE_DIR` relocates config/sessions/credentials. For per-profile skill
  isolation gestalt uses one share dir per profile with `credentials/`, `oauth/`,
  `device_id`, `region` symlinked from `~/.kimi-code/` and a copied+patched
  `config.toml` carrying `extra_skill_dirs`.
- Auth: `Authorization: Bearer <token>` on REST; WS subprotocol
  `kimi-code.bearer.<token>`. Envelope: `{code, msg, data, request_id}`;
  `code === 0` is success, HTTP status is transport-level only.

## REST routes used by the adapter

| Purpose                              | Route                                                                                                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness                            | `GET /api/v1/meta`                                                                                                                                                                                                     |
| Create session                       | `POST /api/v1/sessions` body `{metadata: {cwd}}` → `data.id` = `session_...`                                                                                                                                           |
| Session state                        | `GET /api/v1/sessions/{id}` — has `main_turn_active`, `pending_interaction: none\|approval\|question`, `current_prompt_id`, `agent_config.model`                                                                       |
| Submit/queue turn                    | `POST /api/v1/sessions/{id}/prompts` body `{content: [{type:'text',text}], model?, thinking?, permission_mode?, prompt_id?}`; while busy the prompt is enqueued                                                        |
| Steer queued prompt into active turn | `POST /api/v1/sessions/{id}/prompts:steer` body `{prompt_ids: [...]}`                                                                                                                                                  |
| Abort running prompt (interrupt)     | `POST /api/v1/sessions/{id}/prompts/{prompt_id}:abort` (tail dispatcher) or WS `abort` frame `{session_id, prompt_id}`                                                                                                 |
| Switch model/effort mid-session      | `POST /api/v1/sessions/{id}/profile` body `{agent_config: {model, thinking?, permission_mode?}}` (applies immediately)                                                                                                 |
| History                              | `GET /api/v1/sessions/{id}/messages` (also `/transcript`, `/transcript/user-messages`)                                                                                                                                 |
| List models                          | `GET /api/v1/models` → `data.items[]` = `{provider, model, display_name?, max_context_size, capabilities?, support_efforts?, default_effort?}`                                                                         |
| Default model/config                 | `GET /api/v1/config` → `default_model`, `extra_skill_dirs`, …                                                                                                                                                          |
| Merge-patch config                   | `POST /api/v1/config`                                                                                                                                                                                                  |
| Pending approvals                    | `GET /api/v1/sessions/{id}/approvals` → items `{approval_id, tool_name, action, tool_input_display, expires_at, ...}`                                                                                                  |
| Resolve approval                     | `POST /api/v1/sessions/{id}/approvals/{approval_id}` body `{decision: 'approved'\|'rejected'\|'cancelled', scope?, feedback?, selected_label?}`                                                                        |
| Pending questions                    | `GET /api/v1/sessions/{id}/questions` → items `{question_id, questions: [{id, question, header?, body?, options: [{id,label,description?]}]}]}`                                                                        |
| Answer question                      | `POST /api/v1/sessions/{id}/questions/{question_id}` body `{answers: {<qid>: {kind: 'single'\|'multi'\|'other'\|'multi_with_other'\|'skipped', ...}}}`; `.../questions/{id}:dismiss` dismisses (success code `40909`!) |
| Session skills                       | `GET /api/v1/sessions/{id}/skills`; workspace-scoped: `GET /api/v1/workspaces/{id}/skills`                                                                                                                             |
| Recent sessions                      | `GET /api/v2/sessions?workspace.id=…&sort=meta.updated_at_desc`                                                                                                                                                        |
| Workspace register/trust             | `POST /api/v1/workspaces` `{root}` (idempotent); trust via `POST /api/v1/workspaces/{id}/trust`                                                                                                                        |

## WebSocket (`/api/v1/ws`)

- Control frames (client→server): `client_hello {client_id}`,
  `subscribe {session_ids, cursors?: {<sid>: {seq, epoch?}}, agent_filter?}`,
  `unsubscribe`, `abort {session_id, prompt_id}`, terminal frames. Every request
  frame gets `{type:'ack', id, code, msg}` (`code 0` = ok). Server sends
  `server_hello`, `ping` (reply implicit), `resync_required`.
- Event frames: `{type: <event type>, seq, epoch?, volatile?, offset?,
session_id?, timestamp, payload}`. With `cursors`, durable missed events are
  replayed.
- **There are no `event.approval.requested` frames in 2.0.2** (docs describe them
  for newer versions). Pending interactions are signaled via
  `agent.status.updated` with status `awaiting_approval` / `awaiting_question`;
  the client then lists `GET .../approvals` / `GET .../questions`.
- Event types (60 payload variants): `turn.started` (`{agentId, turnId:number,
origin}`), `turn.ended` (`{agentId, turnId, reason: completed|cancelled|failed|blocked,
error?}`), `turn.step.*`, `assistant.delta` (`{agentId, turnId, delta}`),
  `thinking.delta`, `tool.call.started` (`{agentId, turnId, toolCallId, name, args,
display: {kind: command|bash|file_io|diff|search|url_fetch|agent_call|skill_call|...}}`),
  `tool.call.delta`, `tool.progress`, `tool.result` (`{toolCallId, output, isError,
synthetic}`), `shell.started/output/completed`, `subagent.spawned/started/
suspended/completed/failed/cancelled`, `task.started/terminated`,
  `background.task.*`, `compaction.*`, `skill.activated`, `prompt.submitted/
completed/aborted/steered`, `goal.updated`, `agent.status.updated`,
  `agent.created/disposed`, plus global `session.meta.updated`, `event.session.*`,
  `event.workspace.*`, `event.config.*`, `event.model_catalog.*`, `error`, `warning`.
- `turnId` is a per-agent integer; `agentId` distinguishes the main agent from
  subagents (pair with `subagent.*` events for origin routing).

## Mapping notes (gestalt ⇄ kimi)

- gestalt `threadId` ↔ kimi `session_...` id. Turns: gestalt turn id ↔ kimi
  `prompt_id` (client-chosen, idempotent submit).
- Approval policy: codex `on-request` → kimi `permission_mode: 'manual'`;
  `never` → `yolo`. Sandbox select is codex-only (no kimi equivalent).
- Steering: submit prompt while busy → enqueued; `prompts:steer` pulls queued
  prompts into the active turn.
