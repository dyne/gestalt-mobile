/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { groupMessages } from './message-groups.js';

describe('groupMessages', () => {
  it('nests consecutive commentary entries beneath their final answer', () => {
    expect(
      groupMessages([
        {
          id: 'user-1',
          role: 'user',
          text: 'Inspect the workspace',
          occurredAt: 1_784_102_400_000,
          complete: true,
        },
        {
          id: 'commentary-1',
          role: 'assistant',
          phase: 'commentary',
          text: 'I will inspect it.',
          occurredAt: 1_784_102_410_000,
          complete: true,
        },
        {
          id: 'commentary-2',
          role: 'assistant',
          phase: 'commentary',
          text: 'The branch is clean.',
          occurredAt: 1_784_102_420_000,
          complete: true,
        },
        {
          id: 'answer-1',
          role: 'assistant',
          phase: 'final_answer',
          text: 'No changes are needed.',
          occurredAt: 1_784_102_520_000,
          complete: true,
        },
      ]),
    ).toEqual([
      {
        id: 'user-1',
        kind: 'user',
        text: 'Inspect the workspace',
        occurredAt: 1_784_102_400_000,
      },
      {
        id: 'answer-1',
        kind: 'assistant',
        commentary: 'I will inspect it.\n\nThe branch is clean.',
        answer: 'No changes are needed.',
        occurredAt: 1_784_102_520_000,
      },
    ]);
  });

  it('groups retry attempts by semantic coordinator stage across distinct control ids in chronology', () => {
    const groups = groupMessages([
      {
        id: 'first',
        role: 'audit',
        text: 'Issued an automatic continuation.',
        controlId: 'control-1',
        occurredAt: 10,
        complete: true,
      },
      {
        id: 'second',
        role: 'audit',
        text: 'Issued an automatic continuation.',
        controlId: 'control-2',
        occurredAt: 20,
        complete: true,
      },
      {
        id: 'older',
        role: 'audit',
        text: 'Issued an automatic continuation.',
        controlId: 'control-0',
        occurredAt: 5,
        complete: true,
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'audit', count: 2, timestamps: [10, 20] });
    expect(groups[1]).toMatchObject({ kind: 'audit', count: 1, timestamps: [5] });
  });
});
