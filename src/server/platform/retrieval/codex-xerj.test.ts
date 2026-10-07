/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexXerj, xerjServerName, xerjTools } from './codex-xerj.js';
import {
  applySkillSelectionSnapshot,
  compileSkillOverride,
} from '../../features/skills/model/skill-profile.js';
import { threadSkillConfig } from '../codex/session-runtime.js';
import { normalizeCodexNotification } from '../codex/normalizer.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(status: 'ready' | 'absent' | 'unavailable' = 'ready') {
  const root = await mkdtemp(join(tmpdir(), 'xerj-native-'));
  roots.push(root);
  const path = join(root, 'SKILL.md');
  await writeFile(path, '# gestalt:xerj\nUse retrieval and verify current sources.');
  const skills = [
    { name: 'gestalt:xerj', path, enabled: false },
    { name: 'gestalt:org-plan', path: '/org/SKILL.md', enabled: true },
  ];
  const capability = {
    check: vi.fn(async () =>
      status === 'ready'
        ? ({
            status,
            endpoint: 'http://127.0.0.1:19200',
            manager: '/private manager/gestalt',
          } as const)
        : status === 'absent'
          ? ({ status } as const)
          : ({ status, reason: 'bad-key' } as const),
    ),
  };
  const adapter = new CodexXerj(capability);
  const rpc = {
    request: vi.fn(async (method: string) =>
      method === 'config/read'
        ? {
            config: {
              developer_instructions: 'Keep user guidance.',
              mcp_servers: {
                alias: { command: '/old/gestalt', args: ['xerj', 'mcp'] },
                other: { command: 'other' },
              },
            },
          }
        : {
            data: [
              {
                name: xerjServerName,
                runtimeStatus: 'connected',
                tools: Object.fromEntries(xerjTools.map((tool) => [tool, {}])),
              },
            ],
          },
    ),
  };
  const selected = compileSkillOverride({ discovered: skills, explicit: [] });
  const prepare = () =>
    adapter.prepare({
      cwd: root,
      deadline: Date.now() + 500,
      rpc,
      skills,
      skillsConfig: selected.skillsConfig,
      config: { model_reasoning_effort: 'high' },
      start: true,
    });
  return { root, path, skills, capability, adapter, rpc, prepare };
}

describe('native runtime retrieval', () => {
  it('reports connection loss through existing chat activity without relaying raw provider errors', () => {
    const event = normalizeCodexNotification('s', 1, 't', {
      method: 'mcpServer/statusUpdated',
      params: { name: 'gestalt-xerj', status: 'failed', error: 'private token=secret-value' },
    });
    expect(event).toMatchObject({
      type: 'activity.updated',
      payload: { label: 'Xerj unavailable' },
    });
    expect(JSON.stringify(event)).not.toContain('secret-value');
    expect(JSON.stringify(event)).toContain('Use rg');
  });
  it('overrides a disabled saved profile only after native connection verification', async () => {
    const f = await setup();
    const state = await f.prepare();
    expect(state.ready).toBe(true);
    expect(state.skillsConfig).toContainEqual({ path: f.path, enabled: true });
    expect(state.skillsConfig).toContainEqual({ path: '/org/SKILL.md', enabled: true });
    expect(state.config).toMatchObject({
      model_reasoning_effort: 'high',
      mcp_servers: {
        alias: { enabled: false },
        [xerjServerName]: { enabled: true, enabled_tools: xerjTools },
      },
    });
    expect(state.config.developer_instructions).toContain('Keep user guidance.');
    expect(await f.adapter.verify(f.rpc, 'root', state)).toBe(true);
    expect(f.rpc.request).toHaveBeenCalledWith('mcpServerStatus/list', {
      threadId: 'root',
      serverName: xerjServerName,
      detail: 'full',
    });
    expect(
      (
        threadSkillConfig(state.skillsConfig, state.config).config as {
          skills: { config: unknown[] };
        }
      ).skills.config,
    ).toContainEqual({ name: 'gestalt:xerj', enabled: true });
  });
  it.each(['absent', 'unavailable'] as const)(
    'excludes forced-on retrieval when %s while preserving fixed infrastructure',
    async (status) => {
      const f = await setup(status);
      const state = await f.prepare();
      expect(state.ready).toBe(false);
      expect(state.skillsConfig).toContainEqual({ path: f.path, enabled: false });
      expect(state.config.developer_instructions).not.toContain('Use retrieval and verify');
      expect(state.config.developer_instructions).toContain(
        'Earlier retrieval guidance is inactive',
      );
    },
  );
  it('never trusts cached tools when the native runtime connection failed', async () => {
    const f = await setup();
    const state = await f.prepare();
    const rpc = {
      request: async () => ({
        data: [
          {
            name: xerjServerName,
            runtimeStatus: 'failed',
            tools: Object.fromEntries(xerjTools.map((tool) => [tool, {}])),
          },
        ],
      }),
    };
    expect(await f.adapter.verify(rpc, 'root', state)).toBe(false);
    state.fallback();
    expect(state.skillsConfig).toContainEqual({ path: f.path, enabled: false });
    expect(state.config).toMatchObject({ mcp_servers: { [xerjServerName]: { enabled: false } } });
  });
  it('shares one absolute readiness deadline and falls back on an incompatible config API', async () => {
    const f = await setup();
    const state = await f.adapter.prepare({
      cwd: f.root,
      deadline: Date.now() - 1,
      rpc: f.rpc,
      skills: f.skills,
      skillsConfig: [],
      config: {},
      start: true,
    });
    expect(state.ready).toBe(false);
    expect(f.capability.check).not.toHaveBeenCalled();
    f.rpc.request.mockRejectedValue(new Error('unsupported'));
    expect((await f.prepare()).ready).toBe(false);
    expect(f.capability.check).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'ignores legacy persisted enabled=%s across availability changes',
    async (enabled) => {
      const f = await setup();
      const selection = [{ name: 'gestalt:xerj', path: f.path, enabled }];
      expect(applySkillSelectionSnapshot(f.skills, selection)[0].enabled).toBe(false);
      expect(
        applySkillSelectionSnapshot(
          f.skills.map((skill) => ({ ...skill, enabled: true })),
          selection,
        )[0].enabled,
      ).toBe(true);
    },
  );
});
