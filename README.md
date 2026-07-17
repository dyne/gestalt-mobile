# Gestalt Mobile

Mobile-first web relay for [Gestalt](https://dyne.org/gestalt) orchestrated
development with durable Codex sessions.

## Prerequisites

- Node.js 24 or newer.
- The `codex` CLI installed, available on `PATH`, and authenticated.
- Optionally, `codex-profile` and a `~/.codex-gestalt` home. When both exist,
  sessions use `codex-profile cli gestalt app-server --stdio`; otherwise they
  fall back automatically to `codex app-server --stdio`.

## Install and run

Run the latest release without a permanent installation:

```sh
npx gestalt-mobile --cwd .
npx --yes gestalt-mobile@latest --cwd ~/devel --port 3000
```

For frequent use, install the executable globally:

```sh
npm install --global gestalt-mobile
gestalt-mobile --cwd .
```

The command prints the loopback URL when it is ready. Open that URL in a
browser. Press Ctrl-C, or send SIGINT or SIGTERM, to stop the HTTP server,
active Codex subprocesses, and database cleanly.

## Command-line options

| Option              | Default             | Purpose                                      |
| ------------------- | ------------------- | -------------------------------------------- |
| `--cwd <path>`      | Current directory   | Root containing selectable workspaces        |
| `--host <address>`  | `127.0.0.1`         | HTTP listen address                          |
| `--port <number>`   | `3000`              | HTTP listen port, from 1 through 65535       |
| `--data-dir <path>` | XDG state directory | Directory containing `relay.sqlite`          |
| `--help`            |                     | Print usage without starting the application |
| `--version`         |                     | Print the installed package version          |

`--cwd` may be relative to the directory where the command is invoked. Its
immediate child directories are the workspaces offered by the application.

Gestalt Mobile has no built-in authentication or TLS. The loopback default is
safe for use on the same computer. `--host 0.0.0.0` exposes the relay and its
Codex controls on every network interface; use it only behind a trusted private
VPN or an authenticated, encrypted reverse proxy.

## Persistent state

With `--data-dir <path>`, state is stored in `<path>/relay.sqlite`; a relative
path is resolved from the command's working directory. Without it, state is
stored below `$XDG_STATE_HOME/gestalt-mobile/<workspace-hash>/relay.sqlite`, or
`~/.local/state/gestalt-mobile/<workspace-hash>/relay.sqlite` when
`XDG_STATE_HOME` is unset. A matching legacy `codex-relay` database is reused
when present.

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

The Git tab reports branch divergence, dirty counts, and recent commits. It can
also clone a Git address into a selected workspace directory below `--cwd`.
Pull
uses `git pull --rebase`. Push is available only for a branch that has an
upstream, is ahead, and is not behind; it never creates an upstream or
force-pushes.

## Versions and upgrades

Inspect the executable and registry versions with:

```sh
gestalt-mobile --version
npm view gestalt-mobile version
```

`npx --yes gestalt-mobile@latest` fetches the current release according to npm's
cache rules. Upgrade a global installation with:

```sh
npm install --global gestalt-mobile@latest
```

If startup reports an incompatible Codex protocol, upgrade Gestalt Mobile or
install the Codex CLI version supported by that release. If session startup
fails, first confirm `codex --version` works in the same shell and that Codex is
authenticated. Use `gestalt-mobile --help` to diagnose rejected options without
starting the server.

## Run from source

```sh
npm ci
npm run build
npm start -- --cwd <relay-root>
```

## Development

Run `npm run check`, `npm test`, `npm run lint`, and `npm run build`.

Maintainers should follow the [npm release operations guide](docs/releasing.md)
when configuring GitHub, rotating credentials, or recovering a partial release.

## Copyright and license

Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>

SPDX-License-Identifier: AGPL-3.0-or-later

Gestalt Mobile is distributed under the GNU Affero General Public License
version 3 or, at your option, any later version. See [LICENSE](LICENSE).
