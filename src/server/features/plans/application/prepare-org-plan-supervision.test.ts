/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import {
  prepareOrgPlanSupervision,
  type PrepareOrgPlanDependencies,
} from './prepare-org-plan-supervision.js';
import { parseSupervisedPlan } from './parse-supervised-plan.js';
import { assessModelPolicyAdmission } from '../domain/model-policy-admission.js';
import { newSessionFallback } from '../../../../shared/contracts/session-defaults.js';

const reference = {
  kind: 'workspace',
  workspaceId: 'opaque',
  planName: '.gestalt/plan.org',
} as const;
function source(state = 'TODO', review = 'UNREVIEWED') {
  return `#+TITLE: Execute test
* ${state} [#A] Work
:PROPERTIES:
:ID: work
:SKILLS: $gestalt:coding
:REVIEW_STATUS: ${review}
:END:
- Effort :: Small
- Goal :: Test preparation.
- Notes :: Preserve progress.
`;
}
function dependencies(text = source()): PrepareOrgPlanDependencies {
  const parsed = parseSupervisedPlan({
    source: text,
    planPath: '/workspace/.gestalt/plan.org',
    workspacePath: '/workspace',
  });
  return {
    resolveReference: vi.fn(async () => ({
      workspacePath: '/workspace',
      planName: reference.planName,
    })),
    read: vi.fn(async () =>
      parsed.kind === 'available'
        ? { ...parsed, canonicalPath: '/workspace/.gestalt/plan.org', revision: 'revision' }
        : { kind: 'invalid' as const, reason: parsed.reason },
    ),
    runtimeAvailable: vi.fn(async () => ({ available: true as const })),
    workspace: vi.fn(async () => ({
      workspace: { id: 'project', name: 'Project', path: '/workspace' },
      revision: 'revision',
    })),
    owner: vi.fn(async () => null),
    policy: assessModelPolicyAdmission,
    settings: vi.fn(async () => ({
      kind: 'available' as const,
      settings: {
        ...newSessionFallback,
        provider: 'codex' as const,
        profile: 'default' as const,
        skillProfile: '',
      },
      skillProfiles: [],
      warnings: [],
      effectiveSkillSelection: { skills: [] },
    })),
  };
}

describe('prepareOrgPlanSupervision', () => {
  it('distinguishes an ownership lookup failure from a Codex runtime failure', async () => {
    const deps = dependencies();
    deps.owner = async () => {
      throw new Error('ownership unavailable');
    };
    expect(await prepareOrgPlanSupervision(reference, deps)).toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
      reason: expect.stringContaining('ownership could not be verified'),
    });
    expect(deps.runtimeAvailable).not.toHaveBeenCalled();
  });
  it.each([
    ['TODO', 'UNREVIEWED'],
    ['WIP', 'UNREVIEWED'],
    ['DONE', 'UNREVIEWED'],
  ])('admits %s/%s without changing plan state', async (state, review) => {
    const deps = dependencies(source(state, review));
    expect(await prepareOrgPlanSupervision(reference, deps)).toMatchObject({
      kind: 'eligible',
      reference,
      title: 'Execute test',
      revision: 'revision',
      sourcePath: '/workspace/.gestalt/plan.org',
      workspace: { id: 'project', name: 'Project', path: '/workspace' },
    });
    expect(deps.read).toHaveBeenCalledWith('/workspace', '.gestalt/plan.org');
    expect(await deps.read('/workspace', '.gestalt/plan.org')).toMatchObject({
      plan: { steps: [{ state, reviewStatus: review }] },
    });
  });

  it('blocks a fully reviewed plan and ordinary/malformed Org documents', async () => {
    expect(
      await prepareOrgPlanSupervision(reference, dependencies(source('DONE', 'REVIEWED'))),
    ).toMatchObject({ code: 'NO_REMAINING_WORK' });
    for (const text of [
      '#+TITLE: Notes\n* Notes',
      source().replace(':END:', ''),
      source().replace(':ID: work', ':ID:'),
      source('WIP') + source('WIP').replace(':ID: work', ':ID: other'),
    ]) {
      expect(await prepareOrgPlanSupervision(reference, dependencies(text))).toMatchObject({
        code: 'INVALID_PLAN',
      });
    }
  });

  it.each(['missing', 'unavailable'] as const)(
    'reports %s files without consulting activation availability',
    async (kind) => {
      const deps = dependencies();
      deps.read = vi.fn(async () => ({ kind }));
      expect(await prepareOrgPlanSupervision(reference, deps)).toMatchObject({
        code: kind === 'missing' ? 'PLAN_NOT_FOUND' : 'PLAN_UNREADABLE',
      });
      expect(deps.owner).not.toHaveBeenCalled();
      expect(deps.runtimeAvailable).not.toHaveBeenCalled();
    },
  );

  it('rejects lost references, unavailable Codex and existing owners with recovery identity', async () => {
    const deps = dependencies();
    deps.resolveReference = async () => null;
    expect(await prepareOrgPlanSupervision(reference, deps)).toMatchObject({
      code: 'REFERENCE_UNAVAILABLE',
    });
    const runtime = dependencies();
    runtime.runtimeAvailable = async () => ({
      available: false,
      code: 'CODEX_NOT_FOUND',
      reason: 'Codex CLI was not found when Mobile started.',
    });
    expect(await prepareOrgPlanSupervision(reference, runtime)).toMatchObject({
      code: 'CODEX_NOT_FOUND',
      reason: 'Codex CLI was not found when Mobile started.',
    });
    const owned = dependencies();
    owned.owner = async () => ({ sessionId: 'existing' });
    expect(await prepareOrgPlanSupervision(reference, owned)).toMatchObject({
      code: 'ACTIVE_SUPERVISION',
      existingSessionId: 'existing',
    });
  });

  it('preserves the existing strict-policy admission failure', async () => {
    const deps = dependencies();
    const read = await deps.read('/workspace', reference.planName);
    if (read.kind !== 'available') throw new Error('fixture');
    deps.read = async () => ({
      ...read,
      plan: {
        ...read.plan,
        modelPolicyVersion: 1,
        modelPolicyAssurance: 'runtime-attested',
        steps: read.plan.steps.map((step) => ({
          ...step,
          modelPolicy: {
            version: 1,
            model: 'model',
            reasoningEffort: 'medium',
            rationale: 'test',
            allowedFallbacks: [],
            escalationTrigger: 'test',
            necessity: null,
          },
        })),
      },
    });
    expect(await prepareOrgPlanSupervision(reference, deps)).toMatchObject({
      code: 'MODEL_POLICY_UNAVAILABLE',
      reason: expect.stringContaining('runtime-attested'),
    });
    expect(deps.owner).not.toHaveBeenCalled();
  });
});
