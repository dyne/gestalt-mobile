import { describe, expect, it } from 'vitest';

import { groupMessages } from './message-groups.js';

describe('groupMessages', () => {
  it('nests consecutive commentary entries beneath their final answer', () => {
    expect(
      groupMessages([
        { id: 'user-1', role: 'user', text: 'Inspect the workspace', complete: true },
        {
          id: 'commentary-1',
          role: 'assistant',
          phase: 'commentary',
          text: 'I will inspect it.',
          complete: true,
        },
        {
          id: 'commentary-2',
          role: 'assistant',
          phase: 'commentary',
          text: 'The branch is clean.',
          complete: true,
        },
        {
          id: 'answer-1',
          role: 'assistant',
          phase: 'final_answer',
          text: 'No changes are needed.',
          complete: true,
        },
      ]),
    ).toEqual([
      { id: 'user-1', kind: 'user', text: 'Inspect the workspace' },
      {
        id: 'answer-1',
        kind: 'assistant',
        commentary: 'I will inspect it.\n\nThe branch is clean.',
        answer: 'No changes are needed.',
      },
    ]);
  });
});
