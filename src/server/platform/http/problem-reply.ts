/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyReply } from 'fastify';

import { problem } from './problem.js';

/** Send the established RFC 7807-compatible response without deciding its semantics. */
export function sendProblem(
  reply: FastifyReply,
  code: string,
  status: number,
  detail: string,
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send(problem(code, status, detail));
}
