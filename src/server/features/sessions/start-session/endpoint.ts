/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { idempotencyKey } from '../../../platform/http/idempotency.js';
import { parseStartSessionRequest } from './request.js';
import { startSession } from './use-case.js';
import { SkillProfileError } from '../../skills/model/errors.js';
import { problem } from '../../../platform/http/problem.js';
import {
  WriterAcquisitionError,
  writerAcquisitionProblem,
} from '../application/writer-acquisition.js';

export function registerStartSession(
  app: FastifyInstance,
  deps: Parameters<typeof startSession>[1] & {
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
    reportFailure?(operation: string, error: unknown): void;
  },
): void {
  app.post('/api/sessions', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const key = idempotencyKey(request.headers);
    const prior = key ? deps.idempotency?.get('start-session', key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const body = parseStartSessionRequest(request.body);
    if (!body)
      return reply.code(400).type('application/problem+json').send({
        type: 'urn:gestalt-mobile:error:invalid-start-session-request',
        title: 'Invalid start session request',
        status: 400,
        detail: 'Workspace, profile, and Codex session settings must be valid.',
        code: 'INVALID_START_SESSION_REQUEST',
        retryable: false,
      });
    let started;
    try {
      started = await startSession(body, deps);
    } catch (error) {
      deps.reportFailure?.('start-session', error);
      if (error instanceof WriterAcquisitionError) {
        const failure = writerAcquisitionProblem(error.kind);
        return reply
          .code(failure.status)
          .type('application/problem+json')
          .send(problem(failure.code, failure.status, failure.detail, failure.retryable));
      }
      const knownFailure = error instanceof Error ? sessionStartProblem(error.message) : null;
      if (knownFailure)
        return reply.code(knownFailure.status).type('application/problem+json').send(knownFailure);
      if (error instanceof Error && error.message === 'CODEX_EXECUTOR_MODEL_UNAVAILABLE')
        return reply
          .code(400)
          .type('application/problem+json')
          .send(
            problem(
              error.message,
              400,
              'The executor model is unavailable in Codex. Choose an available model in New session settings and retry.',
              true,
            ),
          );
      if (
        error instanceof Error &&
        (error.message.startsWith('SESSION_SCRATCH_') ||
          error.message.startsWith('SCRATCH_CLEANUP_'))
      )
        return reply
          .code(503)
          .type('application/problem+json')
          .send(
            problem(
              'SESSION_WORKSPACE_UNAVAILABLE',
              503,
              'The selected workspace is busy or its temporary ownership could not be confirmed. Retry shortly.',
              true,
            ),
          );
      if (
        error instanceof Error &&
        ['ORG_EXECUTOR_PROFILE_UNAVAILABLE', 'ORG_EXECUTOR_PROFILE_INVALID'].includes(error.message)
      )
        return reply
          .code(503)
          .type('application/problem+json')
          .send(
            problem(
              error.message,
              503,
              'The installed Org-plan executor profile could not be configured. Restore the Gestalt agent profile and retry.',
            ),
          );
      if (error instanceof SkillProfileError)
        return reply
          .code(400)
          .type('application/problem+json')
          .send(
            problem(
              error.code,
              400,
              error.code === 'UNKNOWN_SKILL_PROFILE'
                ? 'The selected skill profile does not exist.'
                : 'The selected skill profile is invalid.',
            ),
          );
      throw error;
    }
    if (key) deps.idempotency?.put('start-session', key, 202, JSON.stringify(started));
    return reply.code(202).send(started);
  });
}

/** Public guidance is allowlisted; runtime messages can contain private paths or credentials. */
function sessionStartProblem(code: string) {
  switch (code) {
    case 'CODEX_MODEL_UNAVAILABLE':
    case 'KIMI_MODEL_UNAVAILABLE':
      return problem(
        code,
        400,
        'The selected model is unavailable. Choose an available model in New session settings and retry.',
        true,
      );
    case 'WORKSPACE_NOT_FOUND':
      return problem(
        code,
        404,
        'The selected workspace is no longer available. Select an existing workspace and retry.',
        true,
      );
    case 'PROFILE_NOT_FOUND':
      return problem(
        code,
        400,
        'The selected launcher profile is unavailable. Refresh New session settings and retry.',
        true,
      );
    case 'LLM_RUNTIME_UNAVAILABLE':
      return problem(
        code,
        503,
        'The selected provider runtime is unavailable. Check the provider installation and authentication, then retry.',
        true,
      );
    default:
      return null;
  }
}
