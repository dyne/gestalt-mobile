/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseSupervisedPlan } from './parse-supervised-plan.js';
import { currentExecutableL1Index, type SupervisedPlan } from '../domain/supervised-plan.js';
import { presentPlan } from '../../../../client/features/plans/plan-presentation.js';
import { decideAutopilot, defaultAutopilotPolicy } from '../../autopilot/application/policy.js';
import { disabledAutopilot } from '../../autopilot/domain/autopilot-session.js';
import {
  decideSupervisedLifecycle,
  type ExecutorLifecycle,
} from '../../autopilot/domain/supervised-lifecycle.js';
import {
  resolveOrgPlanCheckpointSignal,
  validateOrgPlanCheckpoint,
} from '../../org-plan-checkpoint/application/validate.js';
import { ORG_PLAN_CAPABILITIES } from '../../../platform/plans/org-plan-capabilities.js';

const now = '2026-10-16T12:00:00Z';
function child(id: string, state: string) {
  return `** ${state} [#A] ${id}\n:PROPERTIES:\n:ID: ${id}\n:END:\n- Why :: Preserve identity\n- Change :: Correct dependency\n- Tests :: Verify consumers\n- Done when :: Reviewed\n`;
}
function source(
  stage:
    | 'nested'
    | 'review9'
    | 'barrier11'
    | 'resume11'
    | 'review11'
    | 'barrier13'
    | 'resume13' = 'nested',
) {
  return (
    '#+TITLE: Nested suspension\n#+SUBTITLE: Consumer regression\n#+DATE: 2026-10-16\n#+KEYWORDS: test\n' +
    Array.from({ length: 14 }, (_, index) => {
      const n = index + 1;
      const state =
        n === 9
          ? stage === 'nested'
            ? 'WIP'
            : 'DONE'
          : n === 11
            ? ['nested', 'review9', 'barrier11'].includes(stage)
              ? 'SUSPENDED'
              : stage === 'resume11'
                ? 'WIP'
                : 'DONE'
            : n === 13
              ? stage === 'resume13'
                ? 'WIP'
                : 'SUSPENDED'
              : n === 14
                ? 'TODO'
                : 'DONE';
      const review =
        state === 'DONE' && !(n === 9 && stage === 'review9') && !(n === 11 && stage === 'review11')
          ? 'REVIEWED'
          : 'UNREVIEWED';
      const dependency = state === 'SUSPENDED' ? `:SUSPENDED_FOR: l${n === 13 ? 11 : 9}\n` : '';
      return (
        `* ${state} [#A] l${n}\n:PROPERTIES:\n:ID: l${n}\n:SKILLS: $vertical-slice-architecture\n:REVIEW_STATUS: ${review}\n:STARTED_AT: 2026-10-16T10:00:00Z\n:ELAPSED_SECONDS: 300\n${dependency}:END:\n- Effort :: Small\n- Goal :: Ordered dependency correction\n- Notes :: Retain physical executors\n` +
        child(`l${n}-1`, state) +
        ([11, 13].includes(n) ? child(`l${n}-history`, 'DONE') : '')
      );
    }).join('')
  );
}
function parse(text: string) {
  return parseSupervisedPlan({
    source: text,
    planPath: '/work/.gestalt/nested.org',
    workspacePath: '/work',
  });
}
function plan(stage: Parameters<typeof source>[0] = 'nested'): SupervisedPlan {
  const result = parse(source(stage));
  if (result.kind !== 'available') throw new Error(result.reason);
  return result.plan;
}

describe('nested-suspension-v1 consumer', () => {
  it('selects only L9 and preserves both paused parents, completed siblings and telemetry', () => {
    const current = plan();
    expect(current.currentStepId).toBe('l9-1');
    expect(currentExecutableL1Index(current)).toBe(8);
    for (const n of [11, 13])
      expect(current.steps[n - 1]).toMatchObject({
        id: `l${n}`,
        state: 'SUSPENDED',
        measurement: { elapsedSeconds: 300 },
        children: [
          { id: `l${n}-1`, state: 'SUSPENDED' },
          { id: `l${n}-history`, state: 'DONE' },
        ],
      });
    expect(current.executionComplete).toBe(false);
  });

  it.each([
    ['fork', (s: string) => s.replace(':SUSPENDED_FOR: l11', ':SUSPENDED_FOR: l9')],
    ['disconnected', (s: string) => s.replace(':SUSPENDED_FOR: l11', ':SUSPENDED_FOR: l10')],
    ['cycle', (s: string) => s.replace(':SUSPENDED_FOR: l9', ':SUSPENDED_FOR: l13')],
    ['self-cycle', (s: string) => s.replace(':SUSPENDED_FOR: l9', ':SUSPENDED_FOR: l11')],
    ['missing target', (s: string) => s.replace(':SUSPENDED_FOR: l9', ':SUSPENDED_FOR: missing')],
    [
      'multiple paused children in one parent',
      (s: string) => s.replace('** DONE [#A] l11-history', '** SUSPENDED [#A] l11-history'),
    ],
    [
      'active child in paused parent',
      (s: string) => s.replace('** SUSPENDED [#A] l11-1', '** WIP [#A] l11-1'),
    ],
    ['forward active parent', (s: string) => s.replace('* TODO [#A] l14', '* WIP [#A] l14')],
    ['multiple active parents', (s: string) => s.replace('* DONE [#A] l1\n', '* WIP [#A] l1\n')],
    [
      'reviewed paused parent',
      (s: string) =>
        s.replace(
          ':REVIEW_STATUS: UNREVIEWED\n:STARTED_AT: 2026-10-16T10:00:00Z\n:ELAPSED_SECONDS: 300\n:SUSPENDED_FOR: l11',
          ':REVIEW_STATUS: REVIEWED\n:STARTED_AT: 2026-10-16T10:00:00Z\n:ELAPSED_SECONDS: 300\n:SUSPENDED_FOR: l11',
        ),
    ],
  ] as const)('refuses %s without a partial plan', (_name, change) => {
    expect(parse(change(source())).kind).toBe('unavailable');
  });

  it('selects review, then each inner suspension barrier before ordered resume', () => {
    for (const [stage, id, index] of [
      ['review9', 'l9', 8],
      ['barrier11', 'l11', -1],
      ['resume11', 'l11-1', 10],
      ['review11', 'l11', 10],
      ['barrier13', 'l13', -1],
      ['resume13', 'l13-1', 12],
    ] as const) {
      const current = plan(stage);
      expect(current.currentStepId).toBe(id);
      expect(currentExecutableL1Index(current)).toBe(index);
      if (index === -1) {
        expect(presentPlan(current).phase).toBe('suspended');
        expect(
          decideAutopilot({
            state: { ...disabledAutopilot('s', now), requestedEnabled: true },
            plan: current,
            activity: null,
            hasPendingInteraction: false,
            now,
            policy: defaultAutopilotPolicy,
          }),
        ).toEqual({ kind: 'observe' });
      }
    }
  });

  it('rejects historical and current paused-child checkpoints in both frames', () => {
    const current = plan();
    for (const n of [11, 13]) {
      expect(
        resolveOrgPlanCheckpointSignal('l2Completed', current, 'p', `l2:l${n}-history:DONE`),
      ).toBeNull();
      expect(
        validateOrgPlanCheckpoint({
          plan: current,
          planIdentity: 'p',
          rootOwned: true,
          hasActiveL1Writer: () => false,
          checkpoint: {
            version: 1,
            kind: 'l2Completed',
            planIdentity: 'p',
            l1Id: `l${n}`,
            l2Id: `l${n}-history`,
            position: `L${n}.2`,
            status: 'DONE',
            changes: 'historical',
            files: 'none',
            tests: 'none',
          },
        }),
      ).toMatchObject({ valid: false, reasonCode: 'l1Suspended' });
    }
    const reviewed = plan('barrier11');
    const accepted = resolveOrgPlanCheckpointSignal(
      'l1Accepted',
      reviewed,
      'p',
      'review:l9:REVIEWED',
    );
    expect(accepted).toMatchObject({ l1Id: 'l9', position: 'L9' });
    expect(
      validateOrgPlanCheckpoint({
        plan: reviewed,
        planIdentity: 'p',
        rootOwned: true,
        hasActiveL1Writer: () => false,
        checkpoint: accepted!,
      }),
    ).toEqual({ valid: true });
  });

  it('never continues paused physical executors and retains their identities through unwind', () => {
    for (const n of [11, 13]) {
      const owner: ExecutorLifecycle = {
        canonicalPosition: `L${n}`,
        canonicalTaskName: `l${n}`,
        taskPath: `/root/l${n}`,
        threadId: `thread-l${n}`,
        l1State: 'SUSPENDED',
        l2State: 'SUSPENDED',
        lastActivityAt: now,
        ownedProcesses: [],
        outcome: 'partial',
        continuationGeneration: 1,
        continuationCount: 3,
      };
      expect(
        decideSupervisedLifecycle({
          plan: plan(),
          executor: owner,
          event: 'executorTurnEnded',
          now,
          policy: {
            continuationBaseDelayMs: 1,
            continuationMaxDelayMs: 10,
            processPollMs: 1,
            processMaxElapsedMs: 1000,
            processMaxRssBytes: 1000,
          },
        }).action.kind,
      ).toBe('continueSupervisor');
      const resumed = plan(n === 11 ? 'resume11' : 'resume13');
      expect(resumed.currentStepId).toBe(`l${n}-1`);
      expect(owner).toMatchObject({
        taskPath: `/root/l${n}`,
        threadId: `thread-l${n}`,
        continuationGeneration: 1,
        continuationCount: 3,
      });
    }
  });

  const helper = process.env.GESTALT_TEST_ORG_PLAN_HELPER;
  if (helper)
    it('consumes actual helper transitions and complete reviewed unwind without replacing IDs', async () => {
      const root = await mkdtemp(join(tmpdir(), 'mobile-nested-helper-'));
      const path = join(root, 'plan.org');
      const run = async (...args: string[]) =>
        promisify(execFile)(helper, [...args.slice(0, 1), path, ...args.slice(1)], {
          env: {
            PATH: process.env.PATH,
            GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: ORG_PLAN_CAPABILITIES,
          },
          timeout: 15000,
        });
      try {
        const original = source('resume13');
        await writeFile(path, original);
        await run('suspend-reopen', 'l13', 'l11');
        await run('l2', 'l11-1', 'WIP');
        await run('suspend-reopen', 'l11', 'l9');
        await run('l2', 'l9-1', 'WIP');
        expect(parse(await readFile(path, 'utf8'))).toMatchObject({
          kind: 'available',
          plan: { currentStepId: 'l9-1' },
        });
        for (const [inner, outer] of [
          [9, 11],
          [11, 13],
        ]) {
          await run('l2', `l${inner}-1`, 'DONE');
          await run('set', `l${inner}`, 'DONE');
          expect(parse(await readFile(path, 'utf8'))).toMatchObject({
            kind: 'available',
            plan: { currentStepId: `l${inner}` },
          });
          await expect(run('resume', `l${outer}`)).rejects.toThrow();
          await run('review', `l${inner}`, 'REVIEWED');
          await run('resume', `l${outer}`);
          expect(parse(await readFile(path, 'utf8'))).toMatchObject({
            kind: 'available',
            plan: { currentStepId: `l${outer}-1` },
          });
        }
        expect(await readFile(path, 'utf8')).toBe(original);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
});
