/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { loadPwaIcon } from './load-pwa-icon.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture(name: string, bytes: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gestalt-pwa-icon-'));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

it('loads an SVG as a scalable install icon', async () => {
  const icon = await loadPwaIcon(await fixture('brand.svg', '<svg viewBox="0 0 64 64"></svg>'));
  expect(icon).toMatchObject({
    contentType: 'image/svg+xml',
    extension: 'svg',
    sizes: 'any',
  });
});

it('reads PNG dimensions from its IHDR header', async () => {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(384, 16);
  bytes.writeUInt32BE(256, 20);

  await expect(loadPwaIcon(await fixture('brand.PNG', bytes))).resolves.toMatchObject({
    contentType: 'image/png',
    extension: 'png',
    sizes: '384x256',
  });
});

it.each([
  ['broken.svg', 'not svg', 'does not contain'],
  ['broken.png', 'not png', 'invalid header'],
])('rejects malformed %s input', async (name, bytes, message) => {
  await expect(loadPwaIcon(await fixture(name, bytes))).rejects.toThrow(message);
});
