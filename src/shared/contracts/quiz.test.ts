/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  GESTALT_QUIZ_TOOL_NAME,
  gestaltQuizDynamicTool,
  isQuizToolResponseForQuiz,
  mapNativeUserInputToQuiz,
  parseQuiz,
  toQuizToolResponse,
} from './quiz.js';

const question = (id = 'mode') => ({
  id,
  header: 'Mode',
  question: 'Which mode should I use?',
  choices: [
    { label: 'Fast', description: 'Optimize for speed.' },
    { label: 'Careful', description: 'Optimize for verification.' },
  ],
  allowCustom: false,
});

describe('quiz contract', () => {
  it.each([1, 3, 6])('accepts a bounded %s-question quiz', (count) => {
    expect(
      parseQuiz({
        questions: Array.from({ length: count }, (_, index) => question(`question-${index}`)),
      }),
    ).toMatchObject({
      questions: expect.arrayContaining([expect.objectContaining({ allowCustom: false })]),
    });
  });

  it('maps native requestUserInput questions, including custom and secret input policy', () => {
    expect(
      mapNativeUserInputToQuiz({
        questions: [
          {
            ...question(),
            options: question().choices,
            choices: undefined,
            isOther: true,
            isSecret: true,
          },
        ],
      }),
    ).toEqual({
      questions: [expect.objectContaining({ allowCustom: true, isSecret: true })],
    });
  });

  it.each([
    { questions: [question('same'), question('same')] },
    { questions: [] },
    { questions: Array.from({ length: 9 }, (_, index) => question(`q${index}`)) },
    { questions: [{ ...question(), choices: [question().choices[0]] }] },
    {
      questions: [
        {
          ...question(),
          choices: [{ label: ' ', description: 'Missing label' }, question().choices[1]],
        },
      ],
    },
    {
      questions: [
        { ...question(), choices: [{ label: 'Fast', description: '' }, question().choices[1]] },
      ],
    },
    { questions: [{ ...question(), allowCustom: undefined }] },
    { questions: [{ ...question(), header: 'x'.repeat(121) }] },
  ])('rejects malformed or unsafe quiz arguments', (input) => {
    expect(parseQuiz(input)).toBeNull();
  });

  it('exposes the exact dynamic tool descriptor', () => {
    expect(gestaltQuizDynamicTool).toEqual({
      type: 'function',
      name: GESTALT_QUIZ_TOOL_NAME,
      description: expect.stringContaining('numbered-choice request'),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['questions'],
        properties: expect.objectContaining({
          questions: expect.objectContaining({ minItems: 1, maxItems: 8 }),
        }),
      },
    });
  });

  it('adapts complete answers into the app-server dynamic-tool response', () => {
    const quiz = parseQuiz({ questions: [question()] })!;
    const response = toQuizToolResponse([{ id: 'mode', answer: 'Fast' }]);
    expect(response).toEqual({
      success: true,
      contentItems: [{ type: 'input_text', text: '{"answers":{"mode":"Fast"}}' }],
    });
    expect(isQuizToolResponseForQuiz(quiz, response)).toBe(true);
    expect(
      isQuizToolResponseForQuiz(quiz, toQuizToolResponse([{ id: 'mode', answer: 'Unexpected' }])),
    ).toBe(false);
  });
});
