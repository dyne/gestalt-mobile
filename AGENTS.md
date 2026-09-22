# Codex Relay agent guide

## Architecture

Organize server use cases under `src/server/features/<context>/<use-case>` as vertical slices. HTTP slices use REPR: route-local request/response schemas, one public endpoint registration entry point, slice-owned validation and orchestration, narrow outbound ports, and a primary endpoint test. Keep shared domain concepts inside their bounded context; extract shared infrastructure only after genuine cross-slice reuse appears.

`src/server/app.ts` owns Fastify construction, cross-cutting browser policy, and the visible order of feature registration. Each feature's `register-routes.ts` owns that feature's endpoint list and accepts only the dependencies it needs. `src/server/composition.ts` remains the sole production constructor for concrete adapters and lifecycle hooks; do not turn these route modules into a service locator or a second composition root. Shared HTTP helpers belong in `src/server/platform/http` only when several endpoints share exactly the same transport contract; they must not decide authorization or business outcomes.

Domain and application code must not import Fastify, SQLite, filesystem, child-process, Svelte, or concrete Git implementations. Put those integrations in `src/server/platform`; wire adapters to slices only in `src/server/composition.ts`. Keep client behavior organized under `src/client/features`.

Route every user-facing operation failure through the shared notification toast pipeline. Inline text may describe durable state or recovery guidance, but must not be the sole error channel and must not introduce a feature-local red error treatment.

## LLM providers

Each relay session belongs to exactly one provider (`codex` or `kimi`, see
`src/shared/contracts/llm-provider.ts`). Provider+model are chosen at session
start; `/model` switching in a chat is restricted to the session's own provider
catalog and must never cross providers. Codex sessions drive a shared
`codex app-server --stdio` child. Kimi sessions drive dedicated `kimi web`
processes that Gestalt spawns and owns (`src/server/platform/kimi/`); because
`kimi web` has no `--skills-dir`, per skill profile availability is enforced by
one isolated `kimi web` state directory (and process) per profile selection,
keyed under `~/.codex-gestalt/gestalt-mobile/kimi/`, with authentication
symlinked from `~/.kimi-code`. Kimi keeps core chat parity only: org-plan and
autopilot tooling stay Codex-only, and the server rejects autopilot toggles for
kimi sessions. Extend the kimi integration only through the platform package
plus composition wiring, never through feature-slice imports of child processes
or filesystem state.

## Codex compatibility

The relay uses a narrow handwritten Codex app-server adapter rather than checked-in generated protocol bindings. Runtime startup reports incompatible Codex CLI versions.

## Kimi compatibility

The kimi integration targets the kimi web REST + WebSocket Server API as
implemented by the installed `kimi` CLI. Startup probes `kimi --version` and
offers the provider only when the CLI is present; incompatible versions are
reported at runtime like Codex protocol mismatches.

## Gestalt context-mode ownership

`gestalt-agents` owns tool-routing instructions, plugin installation, and the
workspace-local mutable-state contract. Codex owns native-tool availability and
app-server activity events; the context-mode plugin owns its MCP methods and
initializes `<workspace>/.gestalt/context-mode`. Mobile owns the durable
session-to-workspace association, preserves that selection through lifecycle
recovery, and relays the resulting activity for presentation. Its prepared
runtime may be shared, but context-mode mutable state must never use Mobile
state or a shared home-global base. Diagnose provider health through the
context-mode health workflow; Mobile does not install or repair it.

## Completion rules

Use Node.js 24 or newer. Before completion and before opening or updating a pull request, run `npm run format:check`, `npm run license:check`, `npm run check`, `npm test`, `npm run lint`, and `npm run build`. Run `npm run test:e2e` for browser-visible behavior or end-to-end relay flows. If `npm run format:check` fails, run `npm run format`, inspect the resulting scope, and rerun the formatting check before committing. If `npm run license:check` fails, run `npm run license:apply`, inspect the resulting scope, and rerun both formatting and license checks before committing.

Do not log prompts, model output, secrets, or environment values. Every accepted file-changing Org L1 has exactly one conventional commit, unless it has no changes.

Deliberate non-goals: no framework rewrite, no global client store, no service locator, and no inversion of Org/native-plan authority.

## Passkey boundary

Passkey authentication is built in, but TLS termination is external. Keep
`--public-origin` equal to the exact browser origin; only `http://localhost` is
valid without HTTPS. Treat the shared authorization database at
`~/.codex-gestalt/gestalt-mobile/auth.sqlite` as private local state: preserve
its RP-ID hostname, and do not document or implement remote recovery, automatic
reset, credential export, or hosted administration.
