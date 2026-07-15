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
});
