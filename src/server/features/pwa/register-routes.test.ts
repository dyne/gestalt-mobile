/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('custom PWA install icon', () => {
  it('serves a manifest pointing only at the configured icon', async () => {
    const staticDir = await mkdtemp(join(tmpdir(), 'gestalt-pwa-static-'));
    directories.push(staticDir);
    await writeFile(join(staticDir, 'index.html'), '<h1>Gestalt</h1>');
    await writeFile(join(staticDir, 'manifest.webmanifest'), '{"name":"packaged"}');
    const bytes = Buffer.from('<svg viewBox="0 0 64 64"></svg>');
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
          providers: { codex: { available: true }, kimi: { available: false as const } },
        }),
      },
      logger: console,
      staticDir,
      pwaIcon: {
        bytes,
        contentType: 'image/svg+xml',
        extension: 'svg',
        sizes: 'any',
      },
    });

    const manifest = await app.inject('/manifest.webmanifest');
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.json()).toMatchObject({
      name: 'Gestalt Mobile',
      icons: [
        {
          src: '/install-icon.svg',
          sizes: 'any',
          type: 'image/svg+xml',
          purpose: 'any',
        },
      ],
    });

    const icon = await app.inject('/install-icon.svg');
    expect(icon.headers['content-type']).toContain('image/svg+xml');
    expect(icon.rawPayload).toEqual(bytes);
    await app.close();
  });
});
