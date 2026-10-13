/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectMetadataRegistryDiagnostics } from './live-project-metadata-diagnostics.mjs';

test('bounded native registry diagnostics require a live child ancestry and disclose no marker contents', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'l11-metadata-diagnostic-')));
  const folder = join(root, 'app', '.codex');
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(folder))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  const registry = join(root, `codex-bwrap-synthetic-mount-targets-${process.getuid()}`);
  const markerDirectory = join(registry, hash.toString(16).padStart(16, '0'));
  mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const input = { folder, temporaryDirectory: root, nativePath: realpathSync(process.execPath) };
  try {
    writeFileSync(join(markerDirectory, String(child.pid)), 'synthetic\n', { mode: 0o600 });
    writeFileSync(join(markerDirectory, 'private-marker-name'), 'private canary', { mode: 0o600 });
    symlinkSync('/proc/self/stat', join(markerDirectory, '9999999999'));
    const live = projectMetadataRegistryDiagnostics(input);
    assert.deepEqual(live, {
      markerDirectoryPresent: true,
      markerCount: 3,
      syntheticMarkers: 1,
      existingMarkers: 0,
      liveOwnedNativeMarkers: 1,
    });
    assert.equal(JSON.stringify(live).includes('private'), false);
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
    assert.equal(projectMetadataRegistryDiagnostics(input).liveOwnedNativeMarkers, 0);
    chmodSync(registry, 0o777);
    assert.deepEqual(projectMetadataRegistryDiagnostics(input), { inspectionUnavailable: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    rmSync(root, { recursive: true });
  }
});

test('absent native bookkeeping gives absence, never inferred authority', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'l11-metadata-diagnostic-')));
  try {
    assert.deepEqual(
      projectMetadataRegistryDiagnostics({
        folder: join(root, '.codex'),
        temporaryDirectory: root,
        nativePath: process.execPath,
      }),
      { markerDirectoryPresent: false },
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
