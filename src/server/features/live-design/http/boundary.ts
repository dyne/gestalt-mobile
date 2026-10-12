/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { problem } from '../../../platform/http/problem.js';
import { fail, LiveAuthError } from '../application/grants.js';

export const liveIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const liveTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const liveGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const liveRunSchema = z.strictObject({
  liveId: liveIdSchema,
  generation: liveGenerationSchema,
});

/** Applied at route scope, including validation errors, so grants are never cacheable. */
export function registerLiveHttpBoundary(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    const failure =
      error instanceof LiveAuthError
        ? error
        : (error as { statusCode?: number }).statusCode === 413
          ? new LiveAuthError('LIVE_INVALID_REQUEST', 400)
          : new LiveAuthError('LIVE_AUTH_UNAVAILABLE', 503);
    if (failure.status === 429) reply.header('Retry-After', '60');
    return reply
      .code(failure.status)
      .type('application/problem+json')
      .send(
        problem(
          failure.code,
          failure.status,
          'Live authentication request failed.',
          failure.status === 503,
        ),
      );
  });
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) return fail('LIVE_INVALID_REQUEST', 400);
  return result.data;
}
export function mobileRequest(request: FastifyRequest, mobileOrigin: string): void {
  if (request.headers.origin !== mobileOrigin) fail('ORIGIN_NOT_ALLOWED', 403);
  if (request.url.includes('?')) fail('LIVE_INVALID_REQUEST', 400);
}
export function previewRequest(request: FastifyRequest, origin: string, unsafe: boolean): void {
  // Origin is fixed by the listener's trusted allocation, never X-Forwarded-* or Referer.
  if (request.headers.host !== new URL(origin).host) fail('LIVE_ORIGIN_MISMATCH', 421);
  if (unsafe && request.headers.origin !== origin) fail('ORIGIN_NOT_ALLOWED', 403);
  if (request.url.includes('?')) fail('LIVE_INVALID_REQUEST', 400);
}
export function previewCookieName(origin: string): string {
  return `__Host-gestalt_live_p${new URL(origin).port || '443'}`;
}
export function deliverPreviewCookie(
  reply: FastifyReply,
  origin: string,
  token: string,
  seconds: number,
): void {
  reply.setCookie(previewCookieName(origin), token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: seconds,
  });
}
