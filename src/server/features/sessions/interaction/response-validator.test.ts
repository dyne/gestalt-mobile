/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { isValidInteractionResponse, isValidQuizInteractionResponse } from './response-validator.js';
import { toQuizToolResponse } from '../../../../shared/contracts/quiz.js';

describe('isValidInteractionResponse', () => {
  it('requires generated user-input answer arrays', () => {
    expect(
      isValidInteractionResponse('userInput', {
        answers: { workspace: { answers: ['continue'] } },
      }),
    ).toBe(true);
    expect(isValidInteractionResponse('userInput', { answers: { workspace: {} } })).toBe(false);
    expect(
      isValidInteractionResponse('userInput', { answers: { workspace: { answers: [1] } } }),
    ).toBe(false);
  });

  it('limits approval decisions to each generated approval response shape', () => {
    expect(isValidInteractionResponse('commandApproval', { decision: 'accept' })).toBe(true);
    expect(
      isValidInteractionResponse('commandApproval', {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: {} } },
      }),
    ).toBe(true);
    expect(
      isValidInteractionResponse('fileChangeApproval', {
        decision: 'acceptWithExecpolicyAmendment',
      }),
    ).toBe(false);
    expect(
      isValidInteractionResponse('permissionsApproval', { permissions: {}, scope: 'session' }),
    ).toBe(true);
  });

  it('requires a complete dynamic-tool response for the originating quiz', () => {
    const quiz = {
      questions: [
        {
          id: 'mode',
          header: 'Mode',
          question: 'Which mode?',
          choices: [
            { label: 'Fast', description: 'Fast path' },
            { label: 'Careful', description: 'Careful path' },
          ],
          allowCustom: false,
        },
      ],
    };
    expect(isValidQuizInteractionResponse(quiz, toQuizToolResponse([{ id: 'mode', answer: 'Fast' }]))).toBe(true);
    expect(isValidQuizInteractionResponse(quiz, toQuizToolResponse([{ id: 'mode', answer: 'Other' }]))).toBe(false);
    expect(isValidInteractionResponse('quiz', { success: true, contentItems: [] })).toBe(false);
  });

  it('accepts the complete Solo and Supervised multi-agent selection exactly as the quiz requested', () => {
    const quiz = {
      questions: [
        {
          id: 'execution_mode',
          header: 'Execution mode',
          question: 'How should this plan run?',
          choices: [
            { label: 'Solo', description: 'One agent executes the plan.' },
            { label: 'Supervised multi-agent', description: 'A supervisor coordinates parallel agents.' },
          ],
          allowCustom: false,
        },
        {
          id: 'review_mode',
          header: 'Review mode',
          question: 'Who reviews the work?',
          choices: [
            { label: 'Solo', description: 'The executor reviews its work.' },
            { label: 'Supervised multi-agent', description: 'The supervisor reviews agent work.' },
          ],
          allowCustom: false,
        },
      ],
    };
    const response = toQuizToolResponse([
      { id: 'execution_mode', answer: 'Solo' },
      { id: 'review_mode', answer: 'Supervised multi-agent' },
    ]);
    expect(isValidQuizInteractionResponse(quiz, response)).toBe(true);
  });
});
