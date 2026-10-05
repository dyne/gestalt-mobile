/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { SessionModelConfig } from './session-model-config.js';

function session(id: string) {
  return RelaySession.create({
    id,
    workspaceId: 'w',
    workspacePath: '/workspace',
    profile: 'default',
    provider: 'codex',
    effectiveSkillSelection: { skills: [] },
    modelSettings: {
      reasoningEffort: 'high',
      executorModel: 'gpt-6.1-sol',
      executorReasoningEffort: 'xhigh',
    },
    now: 't',
  }).snapshot;
}

describe('session model configuration', () => {
  it('preserves installed executor instructions and isolates overrides between sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mobile-model-config-'));
    try {
      await mkdir(join(home, 'agents'));
      const profilePath = join(home, 'agents', 'org-plan-executor.toml');
      const instructions =
        'developer_instructions = """\nKeep the assigned L1 ownership.\nmodel = "instruction-example"\nmodel_reasoning_effort = "instruction-example"\n"""';
      const profile = `name = "org-plan-executor"\n${instructions}\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "high"\n[extra]\nmodel = "leave-table-alone"\n`;
      await writeFile(profilePath, profile);
      const resolver = new SessionModelConfig(home, join(home, 'relay-state'));
      const first = await resolver.resolve(session('first'));
      const second = await resolver.resolve({
        ...session('second'),
        modelSettings: { executorModel: 'gpt-6-sol', executorReasoningEffort: 'medium' },
      });
      const firstPath = (first.agents as Record<string, { config_file: string }>)[
        'org-plan-executor'
      ]!.config_file;
      const secondPath = (second.agents as Record<string, { config_file: string }>)[
        'org-plan-executor'
      ]!.config_file;
      expect(first.model_reasoning_effort).toBe('high');
      expect(firstPath).not.toBe(secondPath);
      expect(await readFile(firstPath, 'utf8')).toBe(
        profile
          .replace('model = "gpt-5.6-terra"', 'model = "gpt-6.1-sol"')
          .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "xhigh"'),
      );
      expect(await readFile(secondPath, 'utf8')).toContain('model = "gpt-6-sol"');
      expect(await readFile(profilePath, 'utf8')).toBe(profile);
      expect(await resolver.resolve({ ...session('legacy'), modelSettings: undefined })).toEqual(
        {},
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports a missing role and refuses ambiguous root assignments', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mobile-model-invalid-'));
    try {
      const resolver = new SessionModelConfig(home, home);
      await expect(resolver.resolve(session('missing'))).rejects.toThrow(
        'ORG_EXECUTOR_PROFILE_UNAVAILABLE',
      );
      await mkdir(join(home, 'agents'));
      await writeFile(
        join(home, 'agents', 'org-plan-executor.toml'),
        'model = "first"\nmodel = "second"\n',
      );
      await expect(resolver.resolve(session('ambiguous'))).rejects.toThrow(
        'ORG_EXECUTOR_PROFILE_INVALID',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
