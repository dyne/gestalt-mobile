# Codex Relay agent guide

## Architecture

Organize server use cases under `src/server/features/<context>/<use-case>` as vertical slices. HTTP slices use REPR: route-local request/response schemas, one public endpoint registration entry point, slice-owned validation and orchestration, narrow outbound ports, and a primary endpoint test. Keep shared domain concepts inside their bounded context; extract shared infrastructure only after genuine cross-slice reuse appears.

`src/server/app.ts` owns Fastify construction, cross-cutting browser policy, and the visible order of feature registration. Each feature's `register-routes.ts` owns that feature's endpoint list and accepts only the dependencies it needs. `src/server/composition.ts` remains the sole production constructor for concrete adapters and lifecycle hooks; do not turn these route modules into a service locator or a second composition root. Shared HTTP helpers belong in `src/server/platform/http` only when several endpoints share exactly the same transport contract; they must not decide authorization or business outcomes.

Domain and application code must not import Fastify, SQLite, filesystem, child-process, Svelte, or concrete Git implementations. Put those integrations in `src/server/platform`; wire adapters to slices only in `src/server/composition.ts`. Keep client behavior organized under `src/client/features`.

## Codex compatibility

The relay uses a narrow handwritten Codex app-server adapter rather than checked-in generated protocol bindings. Runtime startup reports incompatible Codex CLI versions.

## Completion rules

Use Node.js 24 or newer. Before completion and before opening or updating a pull request, run `npm run format:check`, `npm run check`, `npm test`, `npm run lint`, and `npm run build`. Run `npm run test:e2e` for browser-visible behavior or end-to-end relay flows. If `npm run format:check` fails, run `npm run format`, inspect the resulting scope, and rerun the formatting check before committing.

Do not log prompts, model output, secrets, or environment values. Every accepted file-changing Org L1 has exactly one conventional commit, unless it has no changes.

Deliberate non-goals: no framework rewrite, no global client store, no service locator, and no inversion of Org/native-plan authority.

## Passkey boundary

Passkey authentication is built in, but TLS termination is external. Keep
`--public-origin` equal to the exact browser origin; only `http://localhost` is
valid without HTTPS. Treat the shared authorization database at
`~/.codex-gestalt/gestalt-mobile/auth.sqlite` as private local state: preserve
its RP-ID hostname, and do not document or implement remote recovery, automatic
reset, credential export, or hosted administration.
