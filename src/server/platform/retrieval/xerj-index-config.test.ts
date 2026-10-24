/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { checkXerjIndexConfig, saveXerjIndexConfig, xerjIndexConfig } from './xerj-index-config.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('persists an inspectable fingerprint and detects incompatible or damaged configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xerj config '));
  roots.push(directory);
  const config = xerjIndexConfig('/sources', 'ax-root', 'http://127.0.0.1:9200');
  expect(await checkXerjIndexConfig(directory, config)).toBe('missing');
  await saveXerjIndexConfig(directory, config);
  expect(await checkXerjIndexConfig(directory, config)).toBe('compatible');
  const path = join(directory, '.gestalt-index-config.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.settings.root).toBe('/sources');
  expect(saved.settings.contentArguments).toContain('--max-file-gb');
  for (const operational of ['--workers', '--pdf-workers', '--bulk-mb', '--debounce', '--progress'])
    expect(saved.settings.contentArguments).not.toContain(operational);
  expect(
    await checkXerjIndexConfig(
      directory,
      xerjIndexConfig('/other', 'ax-root', 'http://127.0.0.1:9200'),
    ),
  ).toBe('incompatible');
  expect(
    await checkXerjIndexConfig(
      directory,
      xerjIndexConfig('/sources', 'ax-root', 'http://127.0.0.1:9300'),
    ),
  ).toBe('incompatible');
  saved.settings.contentArguments = ['--no-graph', '--max-file-gb', '2'];
  await writeFile(path, JSON.stringify(saved));
  expect(await checkXerjIndexConfig(directory, config)).toBe('incompatible');
  await writeFile(path, '{invalid');
  expect(await checkXerjIndexConfig(directory, config)).toBe('incompatible');
});

it('accepts an intact legacy version fingerprint without imposing a version pin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xerj legacy config '));
  roots.push(directory);
  const config = xerjIndexConfig('/sources', 'ax-root', 'http://127.0.0.1:9200');
  const settings = { ...config.settings, nativeVersion: '1.0.0-rc.87' };
  const legacy = {
    ...config,
    settings,
    fingerprint: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
  };
  await writeFile(join(directory, '.gestalt-index-config.json'), JSON.stringify(legacy));
  expect(await checkXerjIndexConfig(directory, config)).toBe('compatible');
  legacy.settings.nativeVersion = 'tampered';
  await writeFile(join(directory, '.gestalt-index-config.json'), JSON.stringify(legacy));
  expect(await checkXerjIndexConfig(directory, config)).toBe('incompatible');
});
