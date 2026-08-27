/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const detachedChatParameter = 'chat-session';

export function readDetachedChatSession(search: string): string | null {
  const sessionId = new URLSearchParams(search).get(detachedChatParameter)?.trim();
  return sessionId || null;
}

export function detachedChatUrl(href: string, sessionId: string): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(detachedChatParameter, sessionId);
  return url.toString();
}

export function detachedChatWindowName(sessionId: string): string {
  let hash = 2166136261;
  for (const character of sessionId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `gestalt-chat-${(hash >>> 0).toString(36)}`;
}
