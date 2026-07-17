/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  engines: { node: string };
  license: string;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as Manifest;

describe('publishable package manifest', () => {
  it('defines the public Gestalt Mobile executable contract', () => {
    expect(manifest).toMatchObject({
      name: 'gestalt-mobile',
      version: '0.1.0',
      bin: { 'gestalt-mobile': 'dist/server/server/main.js' },
      engines: { node: '>=24.0.0' },
      license: 'AGPL-3.0-or-later',
      files: ['dist/server', 'dist/client', 'README.md', 'LICENSE'],
    });
    expect(manifest.private).not.toBe(true);
    expect(Object.keys(manifest.bin)).toEqual(['gestalt-mobile']);
    expect(manifest.scripts.prepack).toContain('npm run build');
    expect(manifest.scripts.prepack).toContain('npm run protocol:check');
    expect(manifest.scripts['build:server']).toBe('node scripts/build-server.mjs');
  });

  it('keeps Svelte out of production dependencies', () => {
    expect(manifest.dependencies.svelte).toBeUndefined();
    expect(manifest.devDependencies.svelte).toMatch(/^\^5\./);
  });
});
