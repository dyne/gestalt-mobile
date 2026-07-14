# Codex Relay agent guide

Use vertical slices with REPR endpoints. Domain and application code must not import Fastify, SQLite, filesystem, child-process, or Svelte. Generated Codex bindings are version-pinned build inputs; regenerate only with `npm run protocol:generate`.

Run `npm run check`, `npm test`, and `npm run build` before completion. Do not log prompts, model output, secrets, or environment values. Every file-changing Org L2 has a conventional commit.
