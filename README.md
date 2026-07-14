# Codex Relay

Mobile-first relay for Codex CLI app-server sessions. Build with `npm ci && npm run build`; run the server with `npm start -- --cwd <relay-root>`. The relay is HTTP-only and assumes a private VPN trust boundary. Workspaces are immediate child directories of `--cwd`; profiles come from `codex-profile status --json`.

Use the saved Codex thread ID and `codex-profile cli <profile> resume <thread> -C <workspace> --include-non-interactive` for SSH handoff. Git Push stays disabled without an upstream and refreshes are throttled.
