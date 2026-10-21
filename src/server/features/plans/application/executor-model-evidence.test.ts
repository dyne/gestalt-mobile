/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseSupervisedPlan } from './parse-supervised-plan.js';
import {
  ExecutorModelEvidenceReader,
  executionPolicyDigest,
  type ExecutorPolicyContext,
  type RuntimeExecutorConfiguration,
} from './executor-model-evidence.js';

const now = '2026-10-21T15:00:00Z';
function context(sessionId = 'a'): ExecutorPolicyContext {
  const parsed = parseSupervisedPlan({
    workspacePath: '/work',
    planPath: '/work/plan.org',
    source: `#+TITLE: Synthetic policy
#+MODEL_POLICY_VERSION: 1
* WIP [#A] Implement
:PROPERTIES:
:ID: bounded-work
:SKILLS: $nodejs-backend-patterns
:REVIEW_STATUS: UNREVIEWED
:MODEL: gpt-6-luna
:REASONING_EFFORT: medium
:MODEL_RATIONALE: All rubric axes zero; mechanical edit.
:MODEL_FALLBACKS: none
:MODEL_ESCALATION_TRIGGER: An unresolved failing case.
:END:
- Effort :: Small
- Goal :: Implement bounded work
- Notes :: Synthetic
`,
  });
  if (parsed.kind !== 'available') throw new Error('invalid fixture');
  return {
    sessionId,
    provider: 'codex',
    rootThreadId: `root-${sessionId}`,
    planIdentity: 'plan-identity',
    plan: parsed.plan,
    executor: {
      canonicalPosition: 'L1',
      canonicalTaskName: 'l1',
      taskPath: '/root/l1',
      threadId: `child-${sessionId}`,
      continuationGeneration: 1,
      continuationCount: 0,
      l1State: 'WIP',
      lastActivityAt: now,
      ownedProcesses: [],
      outcome: 'partial',
    },
  };
}
function observation(
  overrides: Partial<RuntimeExecutorConfiguration> = {},
): RuntimeExecutorConfiguration {
  return {
    source: 'runtime-thread-metadata',
    observationId: 'fresh-observation',
    observedAt: now,
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    role: 'org-plan-executor',
    settingsRevision: null,
    settingsFingerprint: 'local-settings-digest',
    catalog: {
      source: 'runtime',
      revision: 'local-catalog-digest',
      models: [{ id: 'gpt-6-luna', reasoningEfforts: ['medium'] }],
    },
    ...overrides,
  };
}
function reader(input = context(), observed = observation()) {
  const read = vi.fn(async () => ({ kind: 'observed' as const, configuration: observed }));
  return { read, service: new ExecutorModelEvidenceReader(() => input, { read }) };
}

describe('controller-bound L1 configuration evidence', () => {
  it('binds the current L1/child, reports configured match, and preserves unknown runtime revision/admission', async () => {
    const { service, read } = reader();
    const report = await service.read('a');
    expect(read).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'a',
      rootThreadId: 'root-a',
      threadId: 'child-a',
      taskPath: '/root/l1',
    });
    expect(report).toMatchObject({
      l1: { id: 'bounded-work', position: 1 },
      child: { threadId: 'child-a', generation: 1, continuationCount: 0 },
      effective: { model: 'gpt-6-luna', reasoningEffort: 'medium' },
      configuration: 'match',
      code: 'RUNTIME_REVISION_UNKNOWN',
      settingsRevision: null,
      admitted: false,
      runtimeEnforcement: false,
      source: 'runtime-thread-metadata',
      evidenceScope: 'configured-thread-settings',
      unknown: ['settingsRevision'],
    });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2048);
  });

  it('keeps simultaneous sessions and root thread settings separate', async () => {
    const a = context('a');
    const b = context('b');
    const read = vi.fn(async (input: { threadId: string }) => ({
      kind: 'observed' as const,
      configuration: observation({
        model: input.threadId === 'child-a' ? 'gpt-6-luna' : 'gpt-6-astra',
      }),
    }));
    const service = new ExecutorModelEvidenceReader((id) => (id === 'a' ? a : b), { read });
    const [ra, rb] = await Promise.all([service.read('a'), service.read('b')]);
    expect(ra).toMatchObject({ configuration: 'match', child: { threadId: 'child-a' } });
    expect(rb).toMatchObject({
      configuration: 'mismatch',
      code: 'MODEL_MISMATCH',
      effective: { model: 'gpt-6-astra' },
      child: { threadId: 'child-b' },
    });
  });

  it('binds the exact physical replacement generation without inventing another', async () => {
    const input = context();
    const replacement = {
      ...input,
      executor: {
        ...input.executor!,
        taskPath: '/root/l1_g3',
        threadId: 'physical-3',
        continuationGeneration: 3,
      },
    };
    const { service, read } = reader(replacement);
    expect(await service.read('a')).toMatchObject({
      child: { threadId: 'physical-3', generation: 3 },
    });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'physical-3', taskPath: '/root/l1_g3' }),
    );
  });

  it.each([
    { canonicalPosition: 'L2' },
    { canonicalTaskName: 'l2' },
    { continuationGeneration: 2 },
    { threadId: 'root-a' },
    {
      assignment: {
        canonicalPosition: 'L1',
        canonicalTaskName: 'l1',
        taskName: 'l1',
        taskPath: '/root/l1',
        threadId: 'old-physical',
        generation: 1,
        state: 'resumable' as const,
      },
    },
  ])('refuses inconsistent controller identity %j', async (change) => {
    const input = context();
    const { service, read } = reader({ ...input, executor: { ...input.executor!, ...change } });
    expect(await service.read('a')).toMatchObject({
      code: 'CHILD_BINDING_UNKNOWN',
      effective: { model: null },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['missing effort', { reasoningEffort: null }, 'RUNTIME_SETTINGS_UNKNOWN', 'unknown'],
    ['missing model', { model: null }, 'RUNTIME_SETTINGS_UNKNOWN', 'unknown'],
    ['missing catalog', { catalog: null }, 'CATALOG_UNKNOWN', 'unknown'],
    ['role mismatch', { role: 'org-plan-reviewer' }, 'ROLE_MISMATCH', 'mismatch'],
    ['fixed-role pin mismatch', { model: 'gpt-6.1-sol' }, 'MODEL_MISMATCH', 'mismatch'],
    ['effort mismatch', { reasoningEffort: 'high' }, 'EFFORT_MISMATCH', 'mismatch'],
    [
      'unsupported effort',
      {
        catalog: {
          source: 'runtime',
          revision: 'changed',
          models: [{ id: 'gpt-6-luna', reasoningEfforts: ['low'] }],
        },
      },
      'EFFORT_UNSUPPORTED',
      'mismatch',
    ],
    [
      'unavailable exact model',
      {
        catalog: {
          source: 'runtime',
          revision: 'changed',
          models: [{ id: 'gpt-6-sol', reasoningEfforts: ['medium'] }],
        },
      },
      'MODEL_UNAVAILABLE',
      'mismatch',
    ],
  ] as const)('retains %s as bounded evidence', async (_label, observed, code, configuration) => {
    const { service } = reader(context(), observation(observed));
    const report = await service.read('a');
    expect(report).toMatchObject({ code, configuration, admitted: false });
    if ('reasoningEffort' in observed && observed.reasoningEffort === null)
      expect(report?.unknown).toContain('effective.reasoningEffort');
  });

  it('rereads a resumed child rather than reusing an earlier matching receipt', async () => {
    let input = context();
    let count = 0;
    const read = vi.fn(async () => ({
      kind: 'observed' as const,
      configuration: observation({
        observationId: `read-${++count}`,
        reasoningEffort: count === 1 ? 'medium' : null,
      }),
    }));
    const service = new ExecutorModelEvidenceReader(() => input, { read });
    const first = await service.read('a');
    input = { ...input, executor: { ...input.executor!, continuationCount: 1 } };
    const resumed = await service.read('a');
    expect(first).toMatchObject({
      configuration: 'match',
      child: { observationId: 'read-1', generation: 1 },
    });
    expect(resumed).toMatchObject({
      configuration: 'unknown',
      child: { observationId: 'read-2', generation: 1, continuationCount: 1 },
      effective: { reasoningEffort: null },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('discards an in-flight observation if binding, resume or policy changes', async () => {
    for (const change of ['replacement', 'resume', 'policy']) {
      let input = context();
      const pending =
        Promise.withResolvers<Awaited<ReturnType<ReturnType<typeof reader>['read']>>>();
      const service = new ExecutorModelEvidenceReader(() => input, { read: () => pending.promise });
      const reading = service.read('a');
      if (change === 'replacement')
        input = { ...input, executor: { ...input.executor!, threadId: 'new-thread' } };
      else if (change === 'resume')
        input = { ...input, executor: { ...input.executor!, continuationCount: 1 } };
      else input = { ...input, planIdentity: 'changed-policy' };
      pending.resolve({ kind: 'observed', configuration: observation() });
      expect(await reading).toMatchObject({
        code: 'CONTEXT_CHANGED',
        effective: { model: null, reasoningEffort: null },
        observedAt: null,
      });
    }
  });

  it('keeps Kimi and legacy sessions outside the Org model-policy read path', async () => {
    for (const input of [
      { ...context(), provider: 'kimi' as const },
      { ...context(), plan: { ...context().plan!, modelPolicyVersion: undefined } },
    ]) {
      const { service, read } = reader(input);
      expect(await service.read('a')).toBeNull();
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('does not export oversized identifiers, catalog or untrusted payload text', async () => {
    const canary = 'SENSITIVE_CANARY_'.repeat(300);
    const { service } = reader(
      context(),
      observation({
        model: canary,
        reasoningEffort: canary,
        observationId: canary,
        settingsFingerprint: canary,
        catalog: null,
      }),
    );
    const report = await service.read('a');
    expect(JSON.stringify(report)).not.toContain('SENSITIVE_CANARY');
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2048);
  });

  const helper = process.env.GESTALT_TEST_ORG_PLAN_HELPER;
  if (helper)
    it('matches the reviewed Agents execution-policy digest without promoting local fingerprints', async () => {
      const agents = await import(
        pathToFileURL(resolve(dirname(helper), 'org-plan-effective-settings.mjs')).href
      );
      const policy = context().plan!.steps[0]!.modelPolicy!;
      expect(executionPolicyDigest(policy)).toBe(agents.executionPolicyDigest(policy));
      expect(executionPolicyDigest({ ...policy, rationale: 'Changed prose only' })).toBe(
        executionPolicyDigest(policy),
      );
    });
});
