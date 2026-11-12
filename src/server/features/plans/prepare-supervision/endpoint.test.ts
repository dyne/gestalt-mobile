/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerPrepareOrgPlanSupervision } from './endpoint.js';
import { registerPlanRoutes } from '../register-routes.js';
import { prepareOrgPlanSupervision } from '../application/prepare-org-plan-supervision.js';
import { assessModelPolicyAdmission } from '../domain/model-policy-admission.js';
import { newSessionFallback } from '../../../../shared/contracts/session-defaults.js';

it('delegates opaque workspace/session references and rejects paths or launch overrides', async () => {
  const app = fastify();
  const prepare = vi.fn(async () => ({
    kind: 'blocked' as const,
    code: 'PLAN_NOT_FOUND' as const,
    reason: 'Missing plan.',
  }));
  registerPrepareOrgPlanSupervision(app, { prepare });
  try {
    for (const reference of [
      { kind: 'workspace', workspaceId: 'opaque', planName: '.gestalt/plan.org' },
      { kind: 'session', sessionId: 'opaque-session', planName: '.gestalt/plan.org' },
      { kind: 'retained-session', sessionId: 'opaque-session' },
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/plans/prepare',
        payload: reference,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ code: 'PLAN_NOT_FOUND' });
      expect(prepare).toHaveBeenLastCalledWith(reference);
    }
    for (const payload of [
      null,
      { sourcePath: '/outside/plan.org' },
      {
        kind: 'workspace',
        workspaceId: 'opaque',
        planName: '.gestalt/plan.org',
        autopilotEnabled: true,
      },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/plans/prepare',
            payload: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(prepare).toHaveBeenCalledTimes(3);
  } finally {
    await app.close();
  }
});

it('passes the immutable expected revision and returns a refresh-and-confirm conflict', async () => {
  const app = fastify();
  const prepare = vi.fn(async () => ({
    kind: 'blocked' as const,
    code: 'CONTEXT_CHANGED' as const,
    reason: 'Refresh and confirm again.',
  }));
  registerPrepareOrgPlanSupervision(app, { prepare });
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/api/plans/prepare',
      payload: {
        kind: 'retained-session',
        sessionId: 'opaque-session',
        expectedRevision: 'seen-revision',
      },
    });
    expect(result.statusCode).toBe(409);
    expect(prepare).toHaveBeenCalledWith(
      { kind: 'retained-session', sessionId: 'opaque-session' },
      'seen-revision',
    );
    expect(result.json()).toMatchObject({ code: 'CONTEXT_CHANGED' });
  } finally {
    await app.close();
  }
});

it('prepares repeatedly alongside live-plan routes with no activating attachment or session/turn/Autopilot effects', async () => {
  const app = fastify();
  const effects = { createSession: vi.fn(), startTurn: vi.fn(), enableAutopilot: vi.fn() };
  const open = vi.fn(async () => ({ kind: 'missing' as const }));
  const plan = {
    title: 'Read only',
    steps: [],
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
    executionComplete: false,
    currentStepId: 'work',
  };
  // Real preparation receives only read ports even when the hosting application owns effects.
  const preparation = {
    ...effects,
    resolveReference: async () => ({ workspacePath: '/workspace', planName: '.gestalt/plan.org' }),
    read: async () => ({
      kind: 'available' as const,
      plan,
      canonicalPath: '/workspace/.gestalt/plan.org',
      revision: 'revision',
    }),
    runtimeAvailable: async () => ({ available: true as const }),
    workspace: async () => ({
      workspace: { id: 'project', name: 'Project', path: '/workspace' },
      revision: 'revision',
    }),
    owner: async () => null,
    policy: assessModelPolicyAdmission,
    settings: async () => ({
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
    }),
  };
  registerPlanRoutes(app, {
    prepareOrgPlanRoutes: {
      prepare: (reference) => prepareOrgPlanSupervision(reference, preparation),
    },
    planRoutes: {
      exists: () => true,
      find: () => plan,
      refresh: async () => plan,
      open,
      removeStatus: vi.fn(),
      clear: vi.fn(),
      closed: vi.fn(),
    },
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/plans/prepare',
        payload: { kind: 'workspace', workspaceId: 'opaque', planName: '.gestalt/plan.org' },
      });
      expect(result.json()).toMatchObject({ kind: 'eligible' });
    }
    expect(open).not.toHaveBeenCalled();
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ doneSteps: 0, executionComplete: false });
  } finally {
    await app.close();
  }
});
