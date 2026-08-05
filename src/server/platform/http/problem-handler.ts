/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { ProblemDetail } from '../../../shared/contracts/problem.js';

export function registerProblemHandler(app: FastifyInstance, serveSpa = false): void {
  app.setNotFoundHandler((request, reply) => {
    if (serveSpa && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    const problem: ProblemDetail = {
      type: 'urn:gestalt-mobile:error:not-found',
      title: 'Not found',
      status: 404,
      detail: `No route matches ${request.method} ${request.url}`,
      code: 'NOT_FOUND',
      retryable: false,
    };
    return reply.code(404).type('application/problem+json').send(problem);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
    ) {
      const problem: ProblemDetail = {
        type: 'urn:gestalt-mobile:error:payload-too-large',
        title: 'Payload too large',
        status: 413,
        detail: 'The request body exceeds this endpoint limit.',
        code: 'PAYLOAD_TOO_LARGE',
        retryable: false,
      };
      return reply.code(413).type('application/problem+json').send(problem);
    }
    const problem: ProblemDetail = {
      type: 'urn:gestalt-mobile:error:internal',
      title: 'Internal server error',
      status: 500,
      detail: 'The relay could not complete this request.',
      code: 'INTERNAL_ERROR',
      retryable: true,
    };
    return reply.code(500).type('application/problem+json').send(problem);
  });
}
