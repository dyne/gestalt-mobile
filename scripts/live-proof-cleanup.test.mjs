/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeOwnedProofTree } from './live-proof-cleanup.mjs';

test('closed disposable immutable copies are removed without following external links', () => {
  const root = mkdtempSync(join(tmpdir(), 'l11-entry-'));
  const external = mkdtempSync(join(tmpdir(), 'l11-cleanup-external-'));
  const identity = lstatSync(root);
  const copy = join(root, 'installed', 'package');
  mkdirSync(copy, { recursive: true, mode: 0o700 });
  writeFileSync(join(copy, 'source'), 'immutable', { mode: 0o400 });
  writeFileSync(join(external, 'private'), 'untouched', { mode: 0o400 });
  symlinkSync(external, join(root, 'external'));
  chmodSync(copy, 0o500);
  chmodSync(join(root, 'installed'), 0o500);
  try {
    assert.throws(
      () => removeOwnedProofTree(root, identity, { processesClosed: false }),
      /OWNED_PROOF_PROCESSES_NOT_CLOSED/,
    );
    assert.equal(lstatSync(copy).mode & 0o777, 0o500);
    assert.throws(
      () =>
        removeOwnedProofTree(
          root,
          { ...identity, ino: identity.ino + 1 },
          { processesClosed: true },
        ),
      /OWNED_PROOF_IDENTITY_CHANGED/,
    );
    removeOwnedProofTree(root, identity, { processesClosed: true });
    assert.equal(existsSync(root), false);
    assert.equal(readFileSync(join(external, 'private'), 'utf8'), 'untouched');
    assert.equal(lstatSync(join(external, 'private')).mode & 0o777, 0o400);
  } finally {
    if (existsSync(root)) removeOwnedProofTree(root, identity, { processesClosed: true });
    rmSync(external, { recursive: true });
  }
});

test('a real owned process closes before its immutable working tree is removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'l11-entry-'));
  const identity = lstatSync(root);
  chmodSync(root, 0o500);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root,
    stdio: 'ignore',
  });
  let processesClosed = false;
  const closed = new Promise((done) =>
    child.once('close', () => {
      processesClosed = true;
      done();
    }),
  );
  try {
    await new Promise((done, reject) => {
      child.once('spawn', done);
      child.once('error', reject);
    });
    assert.throws(
      () => removeOwnedProofTree(root, identity, { processesClosed }),
      /OWNED_PROOF_PROCESSES_NOT_CLOSED/,
    );
    assert.equal(existsSync(root), true);
    child.kill('SIGTERM');
    await closed;
    removeOwnedProofTree(root, identity, { processesClosed });
    assert.equal(existsSync(root), false);
  } finally {
    if (!processesClosed) {
      child.kill('SIGTERM');
      await closed;
    }
    if (existsSync(root)) removeOwnedProofTree(root, identity, { processesClosed });
  }
});
