/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const payload = [
  'package.json',
  'README.md',
  'LICENSE',
  'gestalt-supervision-capabilities.json',
  'dist/server/server/main.js',
  'dist/client/index.html',
  'scripts/watch-github-run.mjs',
];

async function validate(files: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'package-contents-'));
  try {
    const report = join(directory, 'report.json');
    await writeFile(report, JSON.stringify([{ files: files.map((path) => ({ path })) }]));
    return spawnSync(process.execPath, ['scripts/check-package-contents.mjs', report], {
      encoding: 'utf8',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('release package payload validation', () => {
  it('accepts the shipped watcher alongside the built application', async () => {
    const result = await validate(payload);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    'scripts/build-server.mjs',
    'scripts/watch-github-run.mjs.map',
    'src/server/main.ts',
    'dist/server/example.test.js',
    'dist/server/private.sqlite',
    'dist/client/plan.org',
  ])('still rejects non-runtime payload %s', async (path) => {
    const result = await validate([...payload, path]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid package payload');
    expect(result.stderr).toContain(path);
  });

  it('requires the shipped watcher', async () => {
    const result = await validate(
      payload.filter((path) => path !== 'scripts/watch-github-run.mjs'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"missing":["scripts/watch-github-run.mjs"]');
  });
});
