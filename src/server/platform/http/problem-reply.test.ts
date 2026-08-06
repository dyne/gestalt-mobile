/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { sendProblem } from './problem-reply.js';

describe('sendProblem', () => {
  it('preserves the status, content type, and stable problem fields', async () => {
    const app = fastify();
    app.get('/', (_request, reply) => sendProblem(reply, 'INVALID_REQUEST', 400, 'Bad input.'));

    const response = await app.inject('/');

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST', status: 400, detail: 'Bad input.' });
    await app.close();
  });
});
