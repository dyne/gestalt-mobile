/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentActivitySnapshot } from '../../agent-activity/model.js';
import type { SupervisedPlan } from '../../plans/domain/supervised-plan.js';
import {
  assessModelPolicyAdmission,
  requireModelPolicyAdmission,
  type ModelPolicyStatus,
} from '../../plans/domain/model-policy-admission.js';
import { AutopilotCoordinator } from './service.js';
import { defaultAutopilotPolicy } from './policy.js';
import { SqliteAutopilotStore } from '../../../platform/persistence/sqlite-autopilot-store.js';
import { migrate } from '../../../platform/persistence/migrate.js';

const policy = {
  version: 1 as const,
  model: 'gpt-6-luna' as const,
  reasoningEffort: 'medium' as const,
  rationale: 'Synthetic',
  allowedFallbacks: [],
  escalationTrigger: 'Focused failure',
  necessity: null,
};
const legacy: SupervisedPlan = {
  title: 'Synthetic',
  totalSteps: 1,
  doneSteps: 0,
  allDone: false,
  currentStepId: 'l1',
  steps: [
    {
      id: 'l1',
      level: 1,
      title: 'Work',
      state: 'WIP',
      priority: 'A',
      reviewStatus: 'UNREVIEWED',
      description: {},
      children: [],
    },
  ],
};
const versioned: SupervisedPlan = {
  ...legacy,
  modelPolicyVersion: 1,
  steps: [{ ...legacy.steps[0]!, modelPolicy: policy }],
};
const now = () => new Date().toISOString();

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T16:00:00Z'));
  const database = new DatabaseSync(':memory:');
  migrate(database);
  database.exec(
    "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
  );
  const store = new SqliteAutopilotStore(database);
  let plan = legacy;
  let policyStatus: ModelPolicyStatus = 'legacy';
  let activeTurnId: string | null = null;
  let pending = false;
  const events: { type: string; payload: unknown }[] = [];
  const start = vi.fn(async () => {
    activeTurnId = 'accepted-root';
  });
  const base = createAgentActivitySnapshot('s', now());
  const activity = {
    ...base,
    confidence: 'fresh' as const,
    root: { ...base.root, state: 'idle' as const },
  };
  const coordinator = new AutopilotCoordinator({
    store,
    now,
    policy: { ...defaultAutopilotPolicy, backoffMs: () => 1 },
    plan: () => ({ plan, identity: 'p' }),
    modelPolicyStatus: () => policyStatus,
    session: () => ({ state: 'ready', threadId: 'root', activeTurnId }),
    activity: () => activity,
    pendingInteraction: () => pending,
    reconcile: async () => ({ compatible: true }),
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    nextControlId: () => 'control',
    turnStarter: { start },
    publish: (_sessionId, type, payload) => events.push({ type, payload }),
  });
  return {
    database,
    store,
    coordinator,
    start,
    events,
    setPolicy: () => {
      plan = { ...versioned, modelPolicyAssurance: 'runtime-attested' };
      policyStatus = 'required';
    },
    setConfigured: () => {
      plan = versioned;
      policyStatus = 'required';
    },
    setUnavailable: () => {
      policyStatus = 'unavailable';
    },
    setLegacy: () => {
      plan = legacy;
      policyStatus = 'legacy';
    },
    setManual: () => {
      activeTurnId = 'manual-root';
    },
    setPending: () => {
      pending = true;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('versioned policy admission prerequisites', () => {
  it('admits legacy and disclosed v1 compatibility; explicit strict remains blocked', () => {
    expect(assessModelPolicyAdmission(legacy)).toEqual({ allowed: true, scope: 'legacy' });
    expect(assessModelPolicyAdmission(versioned)).toMatchObject({
      allowed: true,
      scope: 'configured',
      runtimeEnforcement: false,
    });
    const strict = { ...versioned, modelPolicyAssurance: 'runtime-attested' as const };
    expect(assessModelPolicyAdmission(strict)).toMatchObject({
      allowed: false,
      code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE',
      reason: 'RUNTIME_ATTESTATION_UNAVAILABLE',
    });
    expect(() => requireModelPolicyAdmission(strict)).toThrow('AUTOPILOT_MODEL_POLICY_UNAVAILABLE');
    expect(
      Buffer.byteLength(JSON.stringify(assessModelPolicyAdmission(versioned))),
    ).toBeLessThanOrEqual(2048);
  });
  it.each([
    [{ ...legacy, modelPolicyVersion: 2 }, 'POLICY_VERSION_UNSUPPORTED'],
    [{ ...legacy, modelPolicyVersion: 1 }, 'POLICY_FIELDS_INVALID'],
    [{ ...versioned, modelPolicyVersion: undefined }, 'POLICY_VERSION_UNSUPPORTED'],
    [{ ...versioned, modelPolicyAssurance: 'invented' }, 'ASSURANCE_UNSUPPORTED'],
    [
      {
        ...versioned,
        steps: [{ ...versioned.steps[0]!, modelPolicy: { ...policy, reasoningEffort: 'ultra' } }],
      },
      'EFFORT_UNSUPPORTED',
    ],
    [
      {
        ...versioned,
        steps: [{ ...versioned.steps[0]!, modelPolicy: { ...policy, reasoningEffort: 'high' } }],
      },
      'EFFORT_UNSUPPORTED',
    ],
    [
      {
        ...versioned,
        steps: [{ ...versioned.steps[0]!, modelPolicy: { ...policy, model: 'gpt-6-astra' } }],
      },
      'MODEL_PROHIBITED',
    ],
  ])('rejects incompatible policy fields without a default or fallback', (plan, reason) => {
    expect(assessModelPolicyAdmission(plan as SupervisedPlan)).toMatchObject({
      allowed: false,
      reason,
    });
  });
  it('never reuses a retained legacy plan after a mandatory publication becomes unavailable', () => {
    expect(assessModelPolicyAdmission(legacy, 'unavailable')).toMatchObject({
      allowed: false,
      reason: 'POLICY_PROJECTION_UNAVAILABLE',
    });
  });
});

describe('automatic dispatch policy guard', () => {
  it('activates existing v1 once without approval loops and respects Manual Off', async () => {
    const f = fixture();
    try {
      f.setConfigured();
      expect(f.coordinator.supervisionStarted('s')).toMatchObject({ enabled: true });
      f.coordinator.supervisionStarted('s');
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.coordinator.snapshot('s')).toMatchObject({
        executionAdmission: { allowed: true, assurance: 'configured', runtimeEnforcement: false },
      });
      f.coordinator.disable('s');
      f.coordinator.supervisionStarted('s');
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.coordinator.snapshot('s')).toMatchObject({
        enabled: false,
        reason: 'manualDisabled',
      });
      expect(f.start).toHaveBeenCalledOnce();
    } finally {
      f.database.close();
    }
  });
  it('rejects new-policy enable without writing enabled authority, scheduling, probing or dispatching', async () => {
    const f = fixture();
    try {
      f.setPolicy();
      expect(f.coordinator.enable('s')).toMatchObject({
        allowed: false,
        reason: 'RUNTIME_ATTESTATION_UNAVAILABLE',
      });
      expect(f.coordinator.supervisionStarted('s')).toMatchObject({
        allowed: false,
        reason: 'RUNTIME_ATTESTATION_UNAVAILABLE',
      });
      expect(f.store.find('s')).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.start).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.coordinator.snapshot('s')).toMatchObject({
        enabled: false,
        executionAdmission: { allowed: false },
      });
    } finally {
      f.database.close();
    }
  });

  it.each(['publication', 'timer', 'restart'])(
    'blocks a legacy scheduled start after a mandatory policy change at %s',
    async (boundary) => {
      const f = fixture();
      try {
        f.coordinator.enable('s');
        expect(f.store.findControl('s', 'control')?.status).toBe('scheduled');
        f.setPolicy();
        if (boundary === 'publication') f.coordinator.planStatusChanged('s');
        if (boundary === 'restart') f.coordinator.restore('s');
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.start).not.toHaveBeenCalled();
        expect(f.store.find('s')).toMatchObject({ state: 'safetyPaused', requestedEnabled: false });
        expect(f.store.findControl('s', 'control')?.status).toBe('cancelled');
        expect(
          f.events.filter((event) => event.type === 'autopilot.model-policy-rejected'),
        ).toHaveLength(1);
        f.coordinator.evaluate('s');
        f.coordinator.planStatusChanged('s');
        expect(
          f.events.filter((event) => event.type === 'autopilot.model-policy-rejected'),
        ).toHaveLength(1);
      } finally {
        f.database.close();
      }
    },
  );

  it('preserves legacy continuation and explicit manual Off/intervention', async () => {
    const f = fixture();
    try {
      f.coordinator.enable('s');
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.start).toHaveBeenCalledOnce();
      f.setManual();
      f.setPending();
      f.setPolicy();
      f.coordinator.planStatusChanged('s');
      expect(f.coordinator.disable('s')).toMatchObject({ state: 'disabled', enabled: false });
      f.coordinator.manualSend('s');
      expect(f.store.find('s')?.requestedEnabled).toBe(false);
      f.setLegacy();
      expect(f.coordinator.snapshot('s')).not.toHaveProperty('executionAdmission');
    } finally {
      f.database.close();
    }
  });

  it('blocks incompatible publication while retaining the old readable plan', () => {
    const f = fixture();
    try {
      f.coordinator.enable('s');
      f.setUnavailable();
      f.coordinator.planStatusChanged('s');
      expect(f.coordinator.snapshot('s')).toMatchObject({
        enabled: false,
        executionAdmission: { reason: 'POLICY_PROJECTION_UNAVAILABLE' },
      });
    } finally {
      f.database.close();
    }
  });
});
