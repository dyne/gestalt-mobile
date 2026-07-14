import type { FastifyInstance } from 'fastify';

import type { ProblemDetail } from '../../../shared/contracts/problem.js';

export function registerProblemHandler(app: FastifyInstance, serveSpa = false): void {
  app.setNotFoundHandler((request, reply) => {
    if (serveSpa && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    const problem: ProblemDetail = {
      type: 'urn:codex-relay:error:not-found',
      title: 'Not found',
      status: 404,
      detail: `No route matches ${request.method} ${request.url}`,
      code: 'NOT_FOUND',
      retryable: false,
    };
    return reply.code(404).type('application/problem+json').send(problem);
  });

  app.setErrorHandler((error, _request, reply) => {
    const problem: ProblemDetail = {
      type: 'urn:codex-relay:error:internal',
      title: 'Internal server error',
      status: 500,
      detail: 'The relay could not complete this request.',
      code: 'INTERNAL_ERROR',
      retryable: true,
    };
    return reply.code(500).type('application/problem+json').send(problem);
  });
}
