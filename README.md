# Gestalt mobile client

Mobile-first relay for [gestalt](https://dyne.org/gestalt)
orchestrated development with support for durable sessions.

It is intentionally HTTP-only: run it only on a private VPN or
equivalent trusted network.

## Run

```sh
npm ci
npm run build
npm start -- --cwd <relay-root>
```

`--cwd` is the relay root, which should be a folder containing
organizations which then contain cloned repositories. So its immediate
child directories are selectable workspaces.

## Sessions

Use **Open** to relaunch a released, stopped, or attention-required
relay session from the browser.

The relay keeps SQLite state under the supplied data directory, or
under the root-hashed XDG state directory when `--data-dir` is
omitted. Active durable threads are resumed after a relay restart. A
failed child process is retried with bounded backoff before the
session is marked as requiring attention.

## Mobile recovery

The browser stores the selected session, its replay cursor, and per-session
composer drafts. On a dropped connection it replays retained events; if the
server has pruned the gap, it reloads canonical Codex thread history.

## Git

The Git tab reports branch divergence, dirty counts, and recent commits. Fetch
is coalesced and throttled for 60 seconds after success. Push is available only
for a branch that has an upstream, is ahead, and is not behind; it never creates
an upstream or force-pushes.

## Development

Run `npm run check`, `npm test`, `npm run lint`, `npm run build`, and
`npm run protocol:check`. The protocol check ensures the installed Codex CLI
matches the version tested with the relay's app-server adapter.

Maintainers should follow the [npm release operations guide](docs/releasing.md)
when configuring GitHub, rotating credentials, or recovering a partial release.

## Copyright and license

Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>

SPDX-License-Identifier: AGPL-3.0-or-later

Gestalt Mobile is distributed under the GNU Affero General Public License
version 3 or, at your option, any later version. See [LICENSE](LICENSE).
