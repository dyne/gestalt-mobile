# Codex Relay agent guide

## Architecture

Organize server use cases under `src/server/features/<context>/<use-case>` as vertical slices. HTTP slices use REPR: route-local request/response schemas, one public endpoint registration entry point, slice-owned validation and orchestration, narrow outbound ports, and a primary endpoint test. Keep shared domain concepts inside their bounded context; extract shared infrastructure only after genuine cross-slice reuse appears.

Domain and application code must not import Fastify, SQLite, filesystem, child-process, Svelte, or concrete Git implementations. Put those integrations in `src/server/platform`; wire adapters to slices only in `src/server/composition.ts`. Keep client behavior organized under `src/client/features`.

## Codex compatibility

The relay uses a narrow handwritten Codex app-server adapter rather than checked-in generated protocol bindings. Check the installed CLI against the tested version with `npm run protocol:check`.

## Completion rules

Use Node.js 24 or newer. Before completion run `npm run check`, `npm test`, `npm run lint`, `npm run build`, and `npm run protocol:check`. Run `npm run test:e2e` for browser-visible behavior or end-to-end relay flows.

Do not log prompts, model output, secrets, or environment values. Every file-changing Org L2 has a conventional commit.
