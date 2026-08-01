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
});
