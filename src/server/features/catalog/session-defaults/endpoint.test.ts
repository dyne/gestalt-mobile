/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemSessionDefaults } from '../../../platform/persistence/filesystem-session-defaults.js';
import { registerSessionDefaults } from './endpoint.js';

describe('session defaults', () => {
  it('loads defaults saved before thinking and executor settings were added', async () => {
    const home = await mkdtemp(join(tmpdir(), 'session-defaults-legacy-'));
    try {
      const defaults = {
        workspaceId: 'root',
        skillProfile: '',
        provider: 'codex',
        model: 'gpt-6.1-sol',
        sandbox: 'workspace-git',
        approvalPolicy: 'never',
      };
      await mkdir(join(home, '.gestalt'));
      await writeFile(join(home, '.gestalt/session-defaults.json'), JSON.stringify(defaults));
      await expect(new FilesystemSessionDefaults(home).read()).resolves.toEqual({
        ...defaults,
        reasoningEffort: 'medium',
        executorModel: 'gpt-5.6-terra',
        executorReasoningEffort: 'high',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('persists validated settings under .gestalt across store instances and rejects invalid writes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'session-defaults-'));
    const app = fastify();
    const store = new FilesystemSessionDefaults(home);
    registerSessionDefaults(app, store);
    const defaults = {
      workspaceId: 'root',
      skillProfile: 'focused',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium',
      executorModel: 'gpt-5.6-terra',
      executorReasoningEffort: 'high',
      sandbox: 'workspace-git',
      approvalPolicy: 'never',
    };
    try {
      expect((await app.inject('/api/session-defaults')).json()).toEqual({ defaults: null });
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/session-defaults',
        payload: defaults,
      });
      expect(saved.statusCode).toBe(200);
      expect(await new FilesystemSessionDefaults(home).read()).toEqual(defaults);
      expect(
        JSON.parse(await readFile(join(home, '.gestalt/session-defaults.json'), 'utf8')),
      ).toEqual(defaults);
      const invalid = await app.inject({
        method: 'PUT',
        url: '/api/session-defaults',
        payload: { ...defaults, sandbox: 'invalid' },
      });
      expect(invalid.statusCode).toBe(400);
      expect((await app.inject('/api/session-defaults')).json()).toEqual({ defaults });
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
