/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { readUserInputQuestions, toUserInputResponse } from './user-input-request.js';

describe('user input requests', () => {
  it('extracts safe questions from a Codex request payload', () => {
    expect(
      readUserInputQuestions({
        questions: [
          {
            id: 'choice',
            header: 'Mode',
            question: 'Which mode?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Fast', description: 'Do it quickly' }],
          },
        ],
      }),
    ).toEqual([
      {
        id: 'choice',
        header: 'Mode',
        question: 'Which mode?',
        isSecret: false,
        options: [{ label: 'Fast', description: 'Do it quickly' }],
      },
    ]);
  });

  it('builds the generated answers response shape', () => {
    expect(toUserInputResponse([{ id: 'choice', answer: 'Fast' }])).toEqual({
      answers: { choice: { answers: ['Fast'] } },
    });
  });
});
