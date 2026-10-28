/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import type { SupervisedPlan } from '../../features/plans/domain/supervised-plan.js';
import { requireModelPolicyAdmission } from '../../features/plans/domain/model-policy-admission.js';
import { CodexJsonRpcError } from './json-rpc-client.js';
import { CodexSessionRuntime } from './session-runtime.js';

const versioned: SupervisedPlan = {
  title: 'Synthetic',
  modelPolicyVersion: 1,
  modelPolicyAssurance: 'runtime-attested',
  totalSteps: 1,
  doneSteps: 0,
  allDone: false,
  currentStepId: 'l1',
  steps: [
    {
      id: 'l1',
      title: 'Work',
      level: 1,
      state: 'WIP',
      priority: 'A',
      description: {},
      children: [],
      modelPolicy: {
        version: 1,
        model: 'gpt-6-luna',
        reasoningEffort: 'medium',
        rationale: 'Synthetic',
        allowedFallbacks: [],
        escalationTrigger: 'Focused failure',
        necessity: null,
      },
    },
  ],
};
async function fixture(catalog: unknown = {}) {
  let mandatory = false;
  let selected: { model: string; reasoningEffort: string } | undefined;
  let flipOnMissingChild = false;
  const calls: { method: string; params: unknown }[] = [];
  const launch: ConstructorParameters<typeof CodexSessionRuntime>[0] = () => ({
    rpc: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'model/list') return catalog;
        if (method === 'thread/start') return { thread: { id: 'root' } };
        if (method === 'turn/start') {
          if ((params as { threadId: string }).threadId === 'child' && flipOnMissingChild) {
            mandatory = true;
            throw new CodexJsonRpcError(-32600, 'thread not found: child');
          }
          return { turn: { id: 'accepted' } };
        }
        return {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: () => {},
  });
  const guard = vi.fn(async () => {
    requireModelPolicyAdmission(mandatory ? versioned : null);
    return selected ? { ...selected, assertCurrent: () => {} } : undefined;
  });
  const args: ConstructorParameters<typeof CodexSessionRuntime> = [launch];
  args[14] = guard; // Optional host-only admission port; no model-owned arguments.
  const runtime = new CodexSessionRuntime(...args);
  const session = await runtime.start(
    RelaySession.create({
      id: 's',
      provider: 'codex',
      workspaceId: 'w',
      workspacePath: '/w',
      profile: 'default',
      model: 'gpt-6-astra',
      effectiveSkillSelection: { skills: [] },
      now: '2026-10-21T16:00:00Z',
    }).snapshot,
    '2026-10-21T16:00:00Z',
  );
  calls.length = 0;
  return {
    runtime,
    session,
    calls,
    guard,
    select: (value: { model: string; reasoningEffort: string }) => {
      selected = value;
    },
    setMandatory: () => {
      mandatory = true;
    },
    setFlip: () => {
      flipOnMissingChild = true;
    },
  };
}

describe('executor admission at the owned runtime dispatch boundary', () => {
  it('applies successive supervisor L1 choices to the same child instead of configured defaults', async () => {
    const f = await fixture();
    try {
      const session = {
        ...f.session,
        modelSettings: {
          executorModel: 'gpt-6.1-sol',
          executorReasoningEffort: 'medium' as const,
        },
      };
      f.select({ model: 'gpt-6.1-terra', reasoningEffort: 'high' });
      await f.runtime.startExecutorTurn(session, 'child', 'Synthetic selected work', 'first');
      f.select({ model: 'gpt-6-sol', reasoningEffort: 'low' });
      await f.runtime.startExecutorTurn(session, 'child', 'Synthetic revised work', 'second');
      expect(
        f.calls.filter((call) => call.method === 'turn/start').map((call) => call.params),
      ).toEqual([
        expect.objectContaining({ threadId: 'child', model: 'gpt-6.1-terra', effort: 'high' }),
        expect.objectContaining({ threadId: 'child', model: 'gpt-6-sol', effort: 'low' }),
      ]);
    } finally {
      f.runtime.stopAll();
    }
  });
  it.each([
    [{}, 'EXECUTOR_CATALOG_UNAVAILABLE'],
    [
      { data: [{ id: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] },
      'EXECUTOR_MODEL_UNAVAILABLE',
    ],
    [
      { data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] },
      'EXECUTOR_EFFORT_UNSUPPORTED',
    ],
  ])('rejects unavailable runtime model/effort support before launch', async (catalog, code) => {
    const f = await fixture(catalog);
    try {
      await expect(
        f.runtime.validateExecutorPolicy('s', { model: 'gpt-6-luna', reasoningEffort: 'medium' }),
      ).rejects.toThrow(code);
      expect(f.calls.map((call) => call.method)).toEqual(['model/list']);
    } finally {
      f.runtime.stopAll();
    }
  });
  it('accepts exact runtime model/effort support without creating a child or receipt', async () => {
    const f = await fixture({
      data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
    });
    try {
      await expect(
        f.runtime.validateExecutorPolicy('s', { model: 'gpt-6-luna', reasoningEffort: 'medium' }),
      ).resolves.toBeUndefined();
      expect(f.calls.map((call) => call.method)).toEqual(['model/list']);
    } finally {
      f.runtime.stopAll();
    }
  });
  it('rejects unsupported new-policy work before turn/start, thread/resume or metadata probes', async () => {
    const f = await fixture();
    try {
      f.setMandatory();
      await expect(
        f.runtime.startExecutorTurn(f.session, 'child', 'Synthetic work', 'id'),
      ).rejects.toMatchObject({
        code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE',
        admission: { reason: 'RUNTIME_ATTESTATION_UNAVAILABLE' },
      });
      expect(f.calls).toEqual([]);
    } finally {
      f.runtime.stopAll();
    }
  });
  it('preserves legacy executor continuation and manual root model/repair input', async () => {
    const f = await fixture();
    try {
      expect(
        await f.runtime.startExecutorTurn(f.session, 'child', 'Synthetic followup', 'id'),
      ).toBe('accepted');
      f.setMandatory();
      await f.runtime.startTurn(
        f.session,
        'Synthetic manual review/repair input',
        'manual',
        '2026-10-21T16:01:00Z',
      );
      expect(f.calls.map((call) => call.method)).toEqual(['turn/start', 'turn/start']);
      expect(f.calls[1]?.params).toMatchObject({ threadId: 'root', model: 'gpt-6-astra' });
      expect(f.guard).toHaveBeenCalledOnce();
    } finally {
      f.runtime.stopAll();
    }
  });
  it('rechecks policy before the legacy missing-thread recovery path can resume or retry', async () => {
    const f = await fixture();
    try {
      f.setFlip();
      await expect(
        f.runtime.startExecutorTurn(f.session, 'child', 'Synthetic followup', 'id'),
      ).rejects.toMatchObject({ code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE' });
      expect(f.calls.map((call) => call.method)).toEqual(['turn/start']);
      expect(f.guard).toHaveBeenCalledTimes(2);
    } finally {
      f.runtime.stopAll();
    }
  });
});
