/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toQuizToolResponse } from '../../../../shared/contracts/quiz.js';
import { isValidQuizInteractionResponse } from '../interaction/response-validator.js';
import { registerRespondInteraction } from './endpoint.js';

const quiz = {
  questions: [
    {
      id: 'execution_mode',
      header: 'Execution mode',
      question: 'How should this plan run?',
      choices: [
        { label: 'Solo', description: 'One agent executes the plan.' },
        {
          label: 'Supervised multi-agent',
          description: 'A supervisor coordinates parallel agents.',
        },
      ],
      allowCustom: false,
    },
  ],
};

describe('quiz response lifecycle', () => {
  it('retains malformed and failed replies, forwards a valid selection once, and rejects stale retries', async () => {
    const app = fastify();
    const forwarded: unknown[] = [];
    let pending = true;
    let relayAvailable = false;
    registerRespondInteraction(app, {
      exists: () => true,
      validate: (_sessionId, requestId, value) =>
        requestId === '42' && pending && isValidQuizInteractionResponse(quiz, value),
      reply: (_sessionId, requestId, value) => {
        if (!pending || !relayAvailable || requestId !== '42') return false;
        forwarded.push(value);
        return true;
      },
      resolve: () => {
        if (!pending) return false;
        pending = false;
        return true;
      },
      now: () => 'now',
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/42',
      payload: toQuizToolResponse([{ id: 'execution_mode', answer: 'Unknown' }]),
    });
    expect(invalid.statusCode).toBe(400);
    expect(forwarded).toEqual([]);

    const response = toQuizToolResponse([{ id: 'execution_mode', answer: 'Solo' }]);
    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/42',
      payload: response,
    });
    expect(unavailable.statusCode).toBe(409);
    expect(forwarded).toEqual([]);

    relayAvailable = true;
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/42',
      payload: response,
    });
    expect(accepted.statusCode).toBe(202);
    expect(forwarded).toEqual([response]);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/42',
      payload: response,
    });
    expect(stale.statusCode).toBe(400);
    expect(forwarded).toEqual([response]);
    await app.close();
  });
});
