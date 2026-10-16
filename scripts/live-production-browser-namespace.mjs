/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// Disposable hosted-browser launcher only; never imported by Mobile production.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
const [uidText, gidText, configPath, browserPath] = process.argv.slice(2);
const uid = Number(uidText),
  gid = Number(gidText);
assert.equal(process.getuid(), 0);
assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
assert.ok(isAbsolute(configPath) && realpathSync(configPath) === configPath);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
assert.notEqual(readlinkSync('/proc/self/ns/mnt'), config.serverMount);
const directory = join(config.browserHome, 'tmp');
const info = lstatSync(directory);
assert.equal(realpathSync(directory), directory);
assert.equal(info.uid, uid);
assert.equal(info.mode & 0o777, 0o700);
assert.ok(!config.browserHome.startsWith('/tmp/'));
// The mounted files remain under protected browserHome on the host. Only this
// private browser mount namespace sees their short Unix socket pathname.
execFileSync('/usr/bin/mount', ['--bind', directory, '/tmp'], { stdio: 'ignore', timeout: 5000 });
const child = spawn(
  '/usr/bin/setpriv',
  [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    '--init-groups',
    '/usr/bin/env',
    `HOME=${config.browserHome}`,
    'TMPDIR=/tmp',
    `PLAYWRIGHT_BROWSERS_PATH=${browserPath}`,
    process.execPath,
    resolve('scripts/live-production-edit-browser.mjs'),
    configPath,
  ],
  { stdio: 'inherit', env: { PATH: '/usr/bin:/bin', HOME: config.browserHome } },
);
child.on('error', () => {
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
