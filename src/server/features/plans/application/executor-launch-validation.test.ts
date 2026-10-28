/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import type { ExecutorPolicyContext } from './executor-model-evidence.js';
import {
  ExecutorLaunchValidationReader,
  type RuntimePolicyCatalogRead,
} from './executor-launch-validation.js';

const policy = {
  version: 1 as const,
  model: 'gpt-6.1-sol' as const,
  reasoningEffort: 'medium' as const,
  rationale: 'Existing plan',
  allowedFallbacks: [],
  escalationTrigger: 'Focused failure',
  necessity: null,
};
function context(): ExecutorPolicyContext {
  return {
    sessionId: 's',
    provider: 'codex',
    rootThreadId: 'root',
    planIdentity: 'plan',
    executor: null,
    plan: {
      title: 'Existing v1',
      modelPolicyVersion: 1,
      totalSteps: 1,
      doneSteps: 0,
      allDone: false,
      currentStepId: 'work',
      steps: [
        {
          id: 'work',
          title: 'Work',
          level: 1,
          state: 'TODO',
          priority: 'A',
          reviewStatus: 'UNREVIEWED',
          description: {},
          children: [],
          modelPolicy: policy,
        },
      ],
    },
  };
}
const observed = (
  models = [{ id: policy.model as string, reasoningEfforts: ['medium'] }],
): RuntimePolicyCatalogRead => ({
  kind: 'observed',
  source: 'runtime-model-list',
  observedAt: '2026-10-25T01:00:00Z',
  catalog: { source: 'runtime', revision: 'local-content-digest', models },
});

describe('prelaunch model selection evidence', () => {
  it('admits the supervisor Terra/high choice using the runtime catalog rather than the default tiers', async () => {
    const base = context();
    const ctx: ExecutorPolicyContext = {
      ...base,
      plan: {
        ...base.plan!,
        steps: [
          {
            ...base.plan!.steps[0]!,
            modelPolicy: {
              ...policy,
              model: 'gpt-6.1-terra',
              reasoningEffort: 'high',
            },
          },
        ],
      },
    };
    const reader = new ExecutorLaunchValidationReader(() => ctx, {
      read: async () => observed([{ id: 'gpt-6.1-terra', reasoningEfforts: ['high'] }]),
    });
    expect(await reader.read('s')).toMatchObject({
      validated: true,
      code: 'CATALOG_MATCH',
      requested: { model: 'gpt-6.1-terra', reasoningEffort: 'high' },
    });
  });
  it('validates an existing TODO policy before any child exists without fabricating settings or a server revision', async () => {
    const read = vi.fn(async () => observed());
    const reader = new ExecutorLaunchValidationReader(context, { read });
    const report = await reader.read('s');
    expect(read).toHaveBeenCalledExactlyOnceWith({ sessionId: 's', rootThreadId: 'root' });
    expect(report).toMatchObject({
      scope: 'prelaunch-catalog',
      assurance: 'configured',
      validated: true,
      code: 'CATALOG_MATCH',
      requested: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      catalog: {
        source: 'runtime-model-list',
        fingerprint: 'local-content-digest',
        revisionSource: 'normalized-content-digest',
      },
      runtimeEnforcement: false,
    });
    expect(report).not.toHaveProperty('effective');
    expect(report).not.toHaveProperty('settingsRevision');
    expect(report).not.toHaveProperty('catalogRevision');
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2048);
  });

  it.each([
    ['MODEL_UNAVAILABLE', [{ id: 'gpt-6-sol', reasoningEfforts: ['medium'] }]],
    ['EFFORT_UNSUPPORTED', [{ id: policy.model, reasoningEfforts: ['low'] }]],
  ])('rejects genuine catalog incompatibility: %s', async (code, models) => {
    const reader = new ExecutorLaunchValidationReader(context, {
      read: async () => observed(models),
    });
    expect(await reader.read('s')).toMatchObject({ validated: false, code });
  });

  it('does not downgrade explicit strict assurance or query a catalog as a substitute for attestation', async () => {
    const c = context();
    const read = vi.fn(async () => observed());
    const reader = new ExecutorLaunchValidationReader(
      () => ({ ...c, plan: { ...c.plan!, modelPolicyAssurance: 'runtime-attested' } }),
      { read },
    );
    expect(await reader.read('s')).toMatchObject({
      validated: false,
      code: 'RUNTIME_ATTESTATION_UNAVAILABLE',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('never validates a retained plan after its mandatory projection became unavailable', async () => {
    const c = context();
    const read = vi.fn(async () => observed());
    const reader = new ExecutorLaunchValidationReader(
      () => ({ ...c, modelPolicyStatus: 'unavailable' }),
      { read },
    );
    expect(await reader.read('s')).toMatchObject({
      validated: false,
      code: 'POLICY_PROJECTION_UNAVAILABLE',
      catalog: null,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'throws'])('reports actual catalog read failure: %s', async (mode) => {
    const reader = new ExecutorLaunchValidationReader(context, {
      read: async () => {
        if (mode === 'throws') throw new Error('private transport error');
        return { kind: 'unavailable', code: 'CATALOG_UNAVAILABLE' };
      },
    });
    expect(await reader.read('s')).toMatchObject({
      validated: false,
      catalog: null,
      code: 'CATALOG_UNAVAILABLE',
    });
  });

  it.each(['root', 'policy', 'plan', 'l1'])(
    'rejects stale in-flight observations after %s changes',
    async (change) => {
      let c = context();
      const pending = Promise.withResolvers<RuntimePolicyCatalogRead>();
      const reader = new ExecutorLaunchValidationReader(() => c, { read: () => pending.promise });
      const reading = reader.read('s');
      if (change === 'root') c = { ...c, rootThreadId: 'new-root' };
      if (change === 'plan') c = { ...c, planIdentity: 'new-plan' };
      if (change === 'policy' || change === 'l1')
        c = {
          ...c,
          plan: {
            ...c.plan!,
            steps: [
              {
                ...c.plan!.steps[0]!,
                ...(change === 'l1'
                  ? { id: 'different-l1' }
                  : { modelPolicy: { ...policy, model: 'gpt-6-sol' } }),
              },
            ],
          },
        };
      pending.resolve(observed());
      expect(await reading).toMatchObject({
        validated: false,
        code: 'CONTEXT_CHANGED',
        catalog: null,
      });
    },
  );

  it('reads again instead of reusing an earlier match as launch authority', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(observed())
      .mockResolvedValueOnce({ kind: 'unavailable', code: 'CATALOG_UNAVAILABLE' });
    const reader = new ExecutorLaunchValidationReader(context, { read });
    expect(await reader.read('s')).toMatchObject({ validated: true });
    expect(await reader.read('s')).toMatchObject({ validated: false, catalog: null });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy/provider/session selection outside this read path and bounds identifiers', async () => {
    const c = context();
    const read = vi.fn(async () => observed());
    for (const input of [
      { ...c, provider: 'kimi' as const },
      { ...c, sessionId: 'different' },
      { ...c, plan: { ...c.plan!, modelPolicyVersion: undefined } },
    ]) {
      expect(await new ExecutorLaunchValidationReader(() => input, { read }).read('s')).toBeNull();
    }
    const oversized = {
      ...c,
      plan: { ...c.plan!, steps: [{ ...c.plan!.steps[0]!, id: 'x'.repeat(5000) }] },
    };
    const report = await new ExecutorLaunchValidationReader(() => oversized, { read }).read('s');
    expect(report).toMatchObject({
      validated: false,
      code: 'ROOT_BINDING_MISMATCH',
      l1: { id: null },
    });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2048);
    expect(read).not.toHaveBeenCalled();
  });
});
