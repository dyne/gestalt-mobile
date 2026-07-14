# Codex Relay

Mobile-first relay for one Codex CLI app-server process per durable session.
It is intentionally HTTP-only: run it only on a private VPN or equivalent
trusted network.

## Run

```sh
npm ci
npm run build
npm start -- --cwd <relay-root>
```

`--cwd` is the relay root. Its immediate child directories are selectable
workspaces. Profiles come from `codex-profile status --json`; the default Codex
home is used when no managed profile is present.

The relay keeps SQLite state under the supplied data directory, or under the
root-hashed XDG state directory when `--data-dir` is omitted. Active durable
threads are resumed after a relay restart. A failed child process is retried
with bounded backoff before the session is marked as requiring attention.

## Session handoff

Use **Release** in the mobile Sessions tab before taking over from SSH. It stops
the relay-owned process while retaining the Codex thread ID. The same tab can
copy an argument-safe resume command, for example:

```sh
codex-profile cli <profile> resume <thread-id> -C <workspace> --include-non-interactive
```

Use **Restore** to relaunch a released, stopped, or attention-required relay
session from the browser.

## Mobile recovery

The browser stores the selected session, its replay cursor, and per-session
composer drafts. On a dropped connection it replays retained events; if the
server has pruned the gap, it reloads canonical Codex thread history.

## Git behavior

The Git tab reports branch divergence, dirty counts, and recent commits. Fetch
is coalesced and throttled for 60 seconds after success. Push is available only
for a branch that has an upstream, is ahead, and is not behind; it never creates
an upstream or force-pushes.

## Development

Run `npm run check`, `npm test`, `npm run lint`, `npm run build`, and
`npm run protocol:check`. Generated Codex bindings are checked with the pinned
installed CLI; regenerate them only with `npm run protocol:generate`.
