/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { isPlanPathWithinWorkspace, parseSupervisedPlan } from './parse-supervised-plan.js';

const workspacePath = '/work/project';
const planPath = '/work/project/supervised-plan-tab.org';

function plan(
  input: {
    firstState?: 'TODO' | 'WIP' | 'DONE';
    secondState?: 'TODO' | 'WIP' | 'DONE';
    childState?: 'TODO' | 'WIP' | 'DONE';
    firstReview?: 'UNREVIEWED' | 'REVIEWED';
    subtitle?: string;
  } = {},
): string {
  const firstState = input.firstState ?? 'WIP';
  const secondState = input.secondState ?? 'TODO';
  const childState = input.childState ?? 'WIP';
  const firstReview = input.firstReview ?? 'UNREVIEWED';
  return `#+TITLE: Supervised progress ✨
#+SUBTITLE: ${input.subtitle ?? 'Mobile relay'}
#+DATE: 2026-08-01
#+KEYWORDS: org-plan progress

* ${firstState} [#A] Publish helper
:PROPERTIES:
:ID: publish-helper
:SKILLS: $gestalt:org-plan $context-mode:context-mode
:REVIEW_STATUS: ${firstReview}
:END:
- Effort :: Medium
- Goal :: Emit a session-owned signal.
- Notes :: Keep values immutable.

** ${childState} [#A] Write status
:PROPERTIES:
:ID: write-status
:END:
- Why :: A relay needs a canonical pointer.
- Change :: Atomically replace the signal.
- Tests :: Verify with two sessions.
- Done when :: The status is durable.

* ${secondState} [#B] Render client
:PROPERTIES:
:ID: render-client
:SKILLS: $gestalt:development-testing
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Show the plan.
- Notes :: Keep it accessible.
`;
}

function parse(source = plan()) {
  return parseSupervisedPlan({ source, planPath, workspacePath });
}

describe('parseSupervisedPlan', () => {
  it('projects optional measurements and preserves unavailable quota values', () => {
    const result = parse(
      plan().replace(
        ':REVIEW_STATUS: UNREVIEWED',
        ':REVIEW_STATUS: UNREVIEWED\n:STARTED_AT: 2026-08-01T10:00:00Z\n:UPDATED_AT: 2026-08-01T10:01:00Z\n:ELAPSED_SECONDS: 60\n:WEEKLY_REMAINING_START: 70\n:WEEKLY_REMAINING_CURRENT: 65\n:WEEKLY_PERCENT_USED: 5\n:TOKENS_START: 100\n:TOKENS_CURRENT: 130\n:TOKENS_USED: 30',
      ),
    );
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.plan.steps[0]?.measurement).toMatchObject({
      elapsedSeconds: 60,
      weeklyRemainingStart: 70,
      weeklyRemainingCurrent: 65,
      weeklyPercentUsed: 5,
      tokensStart: 100,
      tokensCurrent: 130,
      tokensUsed: 30,
    });
  });

  it('rejects invalid measurement values while allowing fresh and reset quota states', () => {
    expect(parse()).toEqual(expect.objectContaining({ kind: 'available' }));
    expect(parse()).not.toHaveProperty('plan.steps.0.measurement');
    expect(parse(plan().replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: UNREVIEWED\n:WEEKLY_REMAINING_START: 10\n:WEEKLY_REMAINING_CURRENT: 90\n:WEEKLY_PERCENT_USED: 0'))).toMatchObject({ kind: 'available' });
    expect(parse(plan().replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: UNREVIEWED\n:ELAPSED_SECONDS: -1'))).toEqual({ kind: 'unavailable', reason: 'MISSING_REQUIRED_FIELD' });
  });

  it('projects completion snapshots independently from active and unavailable measurements', () => {
    const result = parse(plan().replace(':REVIEW_STATUS: UNREVIEWED', ':REVIEW_STATUS: UNREVIEWED\n:STARTED_AT: 2026-08-01T10:00:00Z\n:COMPLETED_AT: 2026-08-01T10:02:00Z\n:ELAPSED_SECONDS: 120\n:WEEKLY_REMAINING_END: 60\n:TOKENS_END: 160\n:TOKENS_USED: 60'));
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.plan.steps[0]?.measurement).toMatchObject({
      completedAt: '2026-08-01T10:02:00Z',
      elapsedSeconds: 120,
      weeklyRemainingEnd: 60,
      tokensEnd: 160,
      tokensUsed: 60,
    });
  });
  it('keeps an L1 elapsed interval independent from its nested L2 interval', () => {
    const result = parse(
      plan()
        .replace(
          ':REVIEW_STATUS: UNREVIEWED',
          ':REVIEW_STATUS: UNREVIEWED\n:STARTED_AT: 2026-08-01T10:00:00Z\n:UPDATED_AT: 2026-08-01T10:05:00Z\n:ELAPSED_SECONDS: 300',
        )
        .replace(
          ':ID: write-status\n:END:',
          ':ID: write-status\n:STARTED_AT: 2026-08-01T10:01:00Z\n:UPDATED_AT: 2026-08-01T10:03:00Z\n:ELAPSED_SECONDS: 120\n:END:',
        ),
    );
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;

    const parent = result.plan.steps[0];
    const child = parent?.children[0];
    expect(parent?.measurement).toMatchObject({
      startedAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-01T10:05:00Z',
      elapsedSeconds: 300,
    });
    expect(child?.measurement).toMatchObject({
      startedAt: '2026-08-01T10:01:00Z',
      updatedAt: '2026-08-01T10:03:00Z',
      elapsedSeconds: 120,
    });
  });

  it('projects ordered immutable L1/L2 steps and metadata from the strict dialect', () => {
    const result = parse();
    expect(result).toMatchObject({
      kind: 'available',
      plan: {
        title: 'Supervised progress ✨',
        subtitle: 'Mobile relay',
        date: '2026-08-01',
        keywords: 'org-plan progress',
        totalSteps: 3,
        doneSteps: 0,
        allDone: false,
        currentStepId: 'write-status',
        steps: [
          {
            id: 'publish-helper',
            level: 1,
            state: 'WIP',
            priority: 'A',
            reviewStatus: 'UNREVIEWED',
            skills: ['$gestalt:org-plan', '$context-mode:context-mode'],
            description: { effort: 'Medium', goal: 'Emit a session-owned signal.' },
            children: [
              {
                id: 'write-status',
                level: 2,
                description: {
                  why: 'A relay needs a canonical pointer.',
                  doneWhen: 'The status is durable.',
                },
              },
            ],
          },
          { id: 'render-client', level: 1, priority: 'B' },
        ],
      },
    });
    if (result.kind === 'available') {
      expect(Object.isFrozen(result.plan)).toBe(true);
      expect(Object.isFrozen(result.plan.steps)).toBe(true);
      expect(Object.isFrozen(result.plan.steps[0]!)).toBe(true);
    }
  });

  it('retains explicitly empty optional metadata and description values', () => {
    const result = parse(
      plan({ subtitle: '' }).replace('- Notes :: Keep values immutable.', '- Notes ::'),
    );
    expect(result.kind).toBe('available');
    if (result.kind === 'available') {
      expect(result.plan.subtitle).toBe('');
      expect(result.plan.steps[0]!.description.notes).toBe('');
    }
  });

  it('selects the deepest WIP step before all other current-step rules', () => {
    expect(parse()).toMatchObject({ kind: 'available', plan: { currentStepId: 'write-status' } });
  });

  it('selects a completed L1 awaiting review before the next TODO', () => {
    expect(
      parse(
        plan({
          firstState: 'DONE',
          childState: 'DONE',
          secondState: 'TODO',
          firstReview: 'UNREVIEWED',
        }),
      ),
    ).toMatchObject({ kind: 'available', plan: { currentStepId: 'publish-helper', doneSteps: 2 } });
  });

  it('uses the first remaining TODO after a reviewed milestone', () => {
    expect(
      parse(
        plan({
          firstState: 'DONE',
          childState: 'DONE',
          secondState: 'TODO',
          firstReview: 'REVIEWED',
        }),
      ),
    ).toMatchObject({ kind: 'available', plan: { currentStepId: 'render-client' } });
  });

  it('uses the final L1 after every task is done', () => {
    expect(
      parse(
        plan({
          firstState: 'DONE',
          childState: 'DONE',
          secondState: 'DONE',
          firstReview: 'REVIEWED',
        }),
      ),
    ).toMatchObject({
      kind: 'available',
      plan: { allDone: true, doneSteps: 3, currentStepId: 'render-client' },
    });
  });

  it('treats reopened reviewed L1s as ordinary TODO work', () => {
    expect(
      parse(
        plan({
          firstState: 'TODO',
          childState: 'TODO',
          secondState: 'TODO',
          firstReview: 'REVIEWED',
        }),
      ),
    ).toMatchObject({
      kind: 'available',
      plan: { allDone: false, currentStepId: 'publish-helper' },
    });
  });

  it('rejects duplicate or missing IDs, malformed drawers, and unsupported nesting', () => {
    expect(parse(plan().replace(':ID: write-status', ':ID: publish-helper'))).toEqual({
      kind: 'unavailable',
      reason: 'DUPLICATE_ID',
    });
    expect(parse(plan().replace(':ID: render-client\n', ''))).toEqual({
      kind: 'unavailable',
      reason: 'MISSING_REQUIRED_FIELD',
    });
    expect(parse(plan().replace(':END:\n- Why', '- Why'))).toEqual({
      kind: 'unavailable',
      reason: 'MALFORMED_ORG',
    });
    expect(parse(plan().replace('** WIP', '*** WIP'))).toEqual({
      kind: 'unavailable',
      reason: 'MALFORMED_ORG',
    });
  });

  it('rejects multiple WIP paths rather than choosing an arbitrary snapshot', () => {
    expect(parse(plan().replace('* TODO [#B]', '* WIP [#B]'))).toEqual({
      kind: 'unavailable',
      reason: 'MULTIPLE_WIP',
    });
    expect(
      parse(
        plan()
          .replace('** WIP', '** TODO')
          .replace('* TODO [#B]', '* WIP [#B]')
          .replace(
            '- Goal :: Show the plan.',
            '- Goal :: Show the plan.\n\n** WIP [#A] Another\n:PROPERTIES:\n:ID: another\n:END:\n- Why :: x\n- Change :: x\n- Tests :: x\n- Done when :: x',
          ),
      ),
    ).toEqual({
      kind: 'unavailable',
      reason: 'MULTIPLE_WIP',
    });
  });

  it('rejects missing titles and source paths outside the workspace boundary', () => {
    expect(parse(plan().replace('#+TITLE: Supervised progress ✨\n', ''))).toEqual({
      kind: 'unavailable',
      reason: 'MISSING_TITLE',
    });
    expect(
      parseSupervisedPlan({ source: plan(), planPath: '/work/other/plan.org', workspacePath }),
    ).toEqual({ kind: 'unavailable', reason: 'PATH_OUTSIDE_WORKSPACE' });
  });
});

describe('isPlanPathWithinWorkspace', () => {
  it('uses path segment containment rather than a string prefix', () => {
    expect(isPlanPathWithinWorkspace('/work/project/plan.org', '/work/project')).toBe(true);
    expect(isPlanPathWithinWorkspace('/work/project', '/work/project')).toBe(true);
    expect(isPlanPathWithinWorkspace('/work/project-else/plan.org', '/work/project')).toBe(false);
    expect(isPlanPathWithinWorkspace('/work/project/../other/plan.org', '/work/project')).toBe(
      false,
    );
    expect(isPlanPathWithinWorkspace('plan.org', '/work/project')).toBe(false);
  });
});
