/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyReply } from 'fastify';

type Name = 'gestalt_mobile_login' | 'gestalt_mobile_registration' | 'gestalt_mobile_session';
const seconds: Record<Name, number> = {
  gestalt_mobile_login: 600,
  gestalt_mobile_registration: 600,
  gestalt_mobile_session: 30 * 24 * 60 * 60,
};

function options(name: Name, origin: string) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: origin.startsWith('https://'),
    maxAge: seconds[name],
  };
}
export function setAuthCookie(
  reply: FastifyReply,
  name: Name,
  value: string,
  origin: string,
): void {
  reply.setCookie(name, value, options(name, origin));
}
export function clearAuthCookie(reply: FastifyReply, name: Name, origin: string): void {
  reply.clearCookie(name, options(name, origin));
}
