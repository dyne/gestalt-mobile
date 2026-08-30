/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { formatQuizAnswerPrompt } from './quiz-submission.js';

describe('formatQuizAnswerPrompt', () => {
  it('turns the displayed decision summary into an ordinary user prompt', () => {
    expect(
      formatQuizAnswerPrompt([
        {
          id: 'mode',
          header: 'Execution mode',
          question: 'How should this plan run?',
          answer: 'Supervised multi-agent',
        },
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which files?',
          answer: 'All changed files',
        },
      ]),
    ).toBe(
      'Submitted quiz answers:\n- Execution mode — How should this plan run?\n  Supervised multi-agent\n- Scope — Which files?\n  All changed files',
    );
  });
});
