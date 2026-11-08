/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import {
  prepareOrgPlanSettings,
  type OrgPlanSettingsDependencies,
} from './prepare-org-plan-settings.js';
import {
  newSessionFallback,
  resolveNewSessionDefaults,
  type SessionDefaults,
} from '../../../../shared/contracts/session-defaults.js';
import { startSession } from '../../sessions/start-session/use-case.js';
import type { SkillProfile } from '../../skills/model/skill-profile.js';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';

const catalog = [
  newSessionFallback.model,
  newSessionFallback.executorModel,
  'supervisor-custom',
  'executor-custom',
];
const saved: SessionDefaults = {
  ...newSessionFallback,
  workspaceId: 'unrelated-session-base',
  skillProfile: '',
  provider: 'codex',
  model: 'supervisor-custom',
  reasoningEffort: 'high',
  executorModel: 'executor-custom',
  executorReasoningEffort: 'medium',
  sandbox: 'read-only',
  approvalPolicy: 'on-request',
};
function fixture(defaults: SessionDefaults | null = null) {
  const globals = new Map<string, SkillProfile>();
  let project: SkillProfile | undefined;
  const save = vi.fn();
  const activate = vi.fn(async (session: RelaySessionSnapshot) => session);
  const deps: OrgPlanSettingsDependencies = {
    defaults: { read: vi.fn(async () => defaults) },
    models: { list: vi.fn(async () => catalog) },
    profiles: {
      require: vi.fn(async () => ({ name: 'default', state: 'ok' as const, status: 'ready' })),
    },
    skillProfiles: {
      listGlobalProfileNames: vi.fn(async () => [...globals.keys()]),
      readGlobalProfile: vi.fn(async (name) => globals.get(name)),
      readWorkspaceDefault: vi.fn(async () => project),
    },
    skillCatalog: () => ({
      list: vi.fn(async () => ({
        skills: [
          { name: 'gestalt:org-plan', path: '/skills/org-plan/SKILL.md', enabled: false },
          { name: 'optional', path: '/skills/optional/SKILL.md', enabled: true },
        ],
        errors: [],
      })),
    }),
  };
  return {
    deps,
    globals,
    save,
    activate,
    project: (profile: SkillProfile) => {
      project = profile;
    },
  };
}

describe('prepareOrgPlanSettings', () => {
  it('shares the unset model catalog fallback with ordinary session creation', async () => {
    const f = fixture();
    f.deps.models.list = async () => ['catalog-first', newSessionFallback.executorModel];
    const prepared = await prepareOrgPlanSettings('/plan-project', f.deps);
    const manual = await startSession(
      { workspaceId: 'plan-project', profile: 'default', provider: 'codex' },
      {
        ...f.deps,
        createId: () => 'manual',
        now: () => 't',
        save: f.save,
        workspaces: {
          resolve: async () => ({ id: 'plan-project', name: 'Project', realPath: '/plan-project' }),
        },
      },
    );
    expect(prepared).toMatchObject({ kind: 'available', settings: { model: manual.model } });
    expect(manual.model).toBe('catalog-first');
  });

  it('rejects unavailable executor models before ordinary session persistence too', async () => {
    const f = fixture();
    await expect(
      startSession(
        {
          workspaceId: 'plan-project',
          profile: 'default',
          provider: 'codex',
          executorModel: 'removed',
        },
        {
          ...f.deps,
          createId: () => 'manual',
          now: () => 't',
          save: f.save,
          workspaces: {
            resolve: async () => ({
              id: 'plan-project',
              name: 'Project',
              realPath: '/plan-project',
            }),
          },
        },
      ),
    ).rejects.toThrow('CODEX_EXECUTOR_MODEL_UNAVAILABLE');
    expect(f.save).not.toHaveBeenCalled();
  });
  it.each([null, saved])(
    'matches manual Codex New session settings and immutable skills for saved=%j',
    async (defaults) => {
      const f = fixture(defaults);
      const prepared = await prepareOrgPlanSettings('/plan-project', f.deps);
      expect(prepared.kind).toBe('available');
      expect(f.save).not.toHaveBeenCalled();
      expect(f.activate).not.toHaveBeenCalled();
      if (prepared.kind !== 'available') throw new Error('fixture');
      const form = resolveNewSessionDefaults(defaults, 'codex', catalog);
      const manual = await startSession(
        {
          ...form,
          workspaceId: 'plan-project',
          profile: 'default',
          skillProfile: form.skillProfile || undefined,
        },
        {
          ...f.deps,
          createId: () => 'manual',
          now: () => '2026-11-08T00:00:00Z',
          save: f.save,
          activate: f.activate,
          workspaces: {
            resolve: async () => ({
              id: 'plan-project',
              name: 'Project',
              realPath: '/plan-project',
            }),
          },
        },
      );
      expect(prepared.settings).toMatchObject({
        provider: 'codex',
        model: manual.model,
        reasoningEffort: manual.modelSettings?.reasoningEffort,
        executorModel: manual.modelSettings?.executorModel,
        executorReasoningEffort: manual.modelSettings?.executorReasoningEffort,
        sandbox: manual.executionPolicy?.sandbox,
        approvalPolicy: manual.executionPolicy?.approvalPolicy,
      });
      expect(prepared.effectiveSkillSelection).toEqual(manual.effectiveSkillSelection);
      expect(prepared.effectiveSkillSelection.skills).toContainEqual({
        name: 'gestalt:org-plan',
        path: '/skills/org-plan/SKILL.md',
        enabled: true,
      });
      expect(prepared.settings).not.toHaveProperty('workspaceId');
    },
  );

  it('uses Codex unset-model rules for saved Kimi defaults without inheriting its model', async () => {
    const f = fixture({ ...saved, provider: 'kimi', model: 'kimi-only' });
    const prepared = await prepareOrgPlanSettings('/plan-project', f.deps);
    expect(prepared).toMatchObject({
      kind: 'available',
      settings: {
        provider: 'codex',
        model: newSessionFallback.model,
        executorModel: saved.executorModel,
        sandbox: saved.sandbox,
        approvalPolicy: saved.approvalPolicy,
      },
    });
    expect(f.deps.models.list).toHaveBeenCalledExactlyOnceWith('codex');
  });

  it.each(['supervisor', 'executor'])(
    'rejects an unavailable saved %s model without substitution',
    async (field) => {
      const f = fixture({
        ...saved,
        ...(field === 'supervisor' ? { model: 'removed' } : { executorModel: 'removed' }),
      });
      expect(await prepareOrgPlanSettings('/plan-project', f.deps)).toMatchObject({
        kind: 'unavailable',
        code: 'MODEL_UNAVAILABLE',
      });
      expect(f.deps.profiles.require).not.toHaveBeenCalled();
    },
  );

  it('reports failed/invalid defaults and missing model catalogs explicitly', async () => {
    const f = fixture();
    f.deps.defaults.read = async () => {
      throw new Error('read failed');
    };
    expect(await prepareOrgPlanSettings('/plan-project', f.deps)).toMatchObject({
      code: 'SESSION_DEFAULTS_UNAVAILABLE',
    });
    f.deps.defaults.read = async () => ({ ...saved, model: '' });
    expect(await prepareOrgPlanSettings('/plan-project', f.deps)).toMatchObject({
      code: 'SESSION_DEFAULTS_UNAVAILABLE',
    });
    f.deps.defaults.read = async () => null;
    f.deps.models.list = async () => [];
    expect(await prepareOrgPlanSettings('/plan-project', f.deps)).toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    });
  });

  it('preserves Default/workspace fallback, empty global choices and capability consent', async () => {
    const f = fixture();
    f.project({
      version: 2,
      name: 'project',
      skills: [],
      capabilities: { playwright: { enabled: false } },
    });
    const result = await prepareOrgPlanSettings('/plan-project', f.deps, '');
    expect(result).toMatchObject({
      kind: 'available',
      settings: { skillProfile: '' },
      skillProfiles: [],
      effectiveSkillSelection: { capabilities: { playwright: { enabled: false } } },
    });
    expect(f.deps.skillProfiles.readGlobalProfile).not.toHaveBeenCalled();
    expect(f.deps.skillProfiles.readWorkspaceDefault).toHaveBeenCalledWith('/plan-project');
  });

  it('allows only the chosen global profile override and retains its consent and normal skill snapshot', async () => {
    const f = fixture({ ...saved, skillProfile: 'saved-profile' });
    f.globals.set('saved-profile', { version: 1, name: 'saved-profile', skills: [] });
    f.globals.set('chosen', {
      version: 2,
      name: 'chosen',
      skills: [],
      capabilities: { playwright: { enabled: true } },
    });
    const result = await prepareOrgPlanSettings('/plan-project', f.deps, 'chosen');
    expect(result).toMatchObject({
      kind: 'available',
      settings: { model: saved.model, executorModel: saved.executorModel, skillProfile: 'chosen' },
      effectiveSkillSelection: {
        selectedProfileName: 'chosen',
        capabilities: { playwright: { enabled: true } },
      },
    });
    f.globals.delete('chosen');
    expect(await prepareOrgPlanSettings('/plan-project', f.deps, 'chosen')).toMatchObject({
      code: 'SKILL_PROFILE_UNAVAILABLE',
    });
  });

  it('retains invalid profile errors and warns when normal saved-profile fallback selects Default', async () => {
    const f = fixture({ ...saved, skillProfile: 'broken' });
    f.deps.skillProfiles.listGlobalProfileNames = async () => ['broken'];
    f.deps.skillProfiles.readGlobalProfile = async () => {
      throw new Error('Invalid profile YAML');
    };
    expect(await prepareOrgPlanSettings('/plan-project', f.deps)).toMatchObject({
      kind: 'available',
      settings: { skillProfile: '' },
      warnings: [expect.stringContaining('saved skill profile')],
      skillProfiles: [{ name: 'broken', error: 'Invalid profile YAML' }],
    });
    expect(await prepareOrgPlanSettings('/plan-project', f.deps, 'broken')).toMatchObject({
      code: 'SKILL_PROFILE_UNAVAILABLE',
    });
  });

  it('blocks missing required Gestalt infrastructure and unreadable profile inventory', async () => {
    const f = fixture();
    f.deps.skillCatalog = () => ({ list: async () => ({ skills: [], errors: [] }) });
    expect(await prepareOrgPlanSettings('/plan-project', f.deps)).toMatchObject({
      code: 'GESTALT_CAPABILITIES_UNAVAILABLE',
    });
    f.deps.skillProfiles.listGlobalProfileNames = async () => {
      throw new Error('unreadable');
    };
    expect(await prepareOrgPlanSettings('/plan-project', f.deps)).toMatchObject({
      code: 'SKILL_PROFILE_UNAVAILABLE',
    });
  });
});
