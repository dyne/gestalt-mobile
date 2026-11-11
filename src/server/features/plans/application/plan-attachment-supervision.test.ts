/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import { planAttachmentSupervision } from './plan-attachment-supervision.js';
import type { PlanStatusUpdate } from './ports.js';

const draft: Extract<PlanStatusUpdate, { kind: 'updated' }> = {
  kind: 'updated',
  identity: 'plan',
  planPath: '/workspace/plan.org',
  reason: 'authoring-start',
  plan: {
    title: 'Draft',
    currentStepId: 'work',
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
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
      },
    ],
  },
};
const previous = { filename: 'plan.org', title: 'Draft', path: draft.planPath, attached: true };

it('does not infer execution from a visualized plan with existing work progress', () => {
  const update = {
    ...draft,
    reason: 'display-open' as const,
    plan: {
      ...draft.plan,
      steps: draft.plan.steps.map((step) => ({ ...step, state: 'WIP' as const })),
    },
  };
  expect(planAttachmentSupervision(undefined, update, false)).toBe(false);
  expect(planAttachmentSupervision(previous, update, false)).toBe(false);
  expect(planAttachmentSupervision({ ...previous, supervision: true }, update, false)).toBe(true);
  expect(planAttachmentSupervision(previous, update, true)).toBe(true);
});

it.each(['authoring-start', 'update', 'resync'] as const)(
  'retains %s drafts for display without assigning supervision, including legacy attachments',
  (reason) => {
    expect(planAttachmentSupervision(undefined, { ...draft, reason }, false)).toBe(false);
    expect(planAttachmentSupervision(previous, { ...draft, reason }, false)).toBe(false);
  },
);

it('keeps the draft role when a missing status pointer is reconstructed after restart', () => {
  expect(
    planAttachmentSupervision(
      { ...previous, supervision: false },
      { ...draft, reason: null },
      false,
    ),
  ).toBe(false);
  // Unknown old attachments remain fenced until a recognized publication classifies them.
  expect(planAttachmentSupervision(previous, { ...draft, reason: null }, false)).toBe(true);
});

it.each(['supervision-start', 'work-start', 'checkpoint', 'l2:work:WIP'] as const)(
  'claims supervision on %s even before the first state change',
  (reason) => {
    expect(planAttachmentSupervision(previous, { ...draft, reason }, false)).toBe(true);
  },
);

it('never releases an established supervisor on authoring, resync, or a reset to TODO', () => {
  expect(planAttachmentSupervision({ ...previous, supervision: true }, draft, false)).toBe(true);
  expect(planAttachmentSupervision(previous, draft, true)).toBe(true);
  expect(
    planAttachmentSupervision(
      { ...previous, path: '/workspace/other.org', supervision: true },
      draft,
      false,
    ),
  ).toBe(false);
  expect(
    planAttachmentSupervision({ ...previous, attached: false, supervision: true }, draft, false),
  ).toBe(false);
});

it('preserves legacy execution ownership when any child already has work progress', () => {
  const step = draft.plan.steps[0]!;
  expect(
    planAttachmentSupervision(
      previous,
      {
        ...draft,
        reason: 'resync',
        plan: {
          ...draft.plan,
          steps: [{ ...step, children: [{ ...step, id: 'child', level: 2, state: 'DONE' }] }],
        },
      },
      false,
    ),
  ).toBe(true);
});

it('does not mistake drafting a WIP heading for permission to execute', () => {
  const update = {
    ...draft,
    plan: {
      ...draft.plan,
      steps: draft.plan.steps.map((step) => ({ ...step, state: 'WIP' as const })),
    },
  };
  expect(planAttachmentSupervision(undefined, update, false)).toBe(false);
  expect(
    planAttachmentSupervision(
      { ...previous, supervision: false },
      { ...update, reason: 'resync' },
      false,
    ),
  ).toBe(false);
});
