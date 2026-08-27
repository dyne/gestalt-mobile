/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  detachedChatUrl,
  detachedChatWindowName,
  readDetachedChatSession,
} from './detached-chat.js';

describe('detached Chat location', () => {
  it('reads only a non-empty pinned session ID', () => {
    expect(readDetachedChatSession('?chat-session=session%2Fone')).toBe('session/one');
    expect(readDetachedChatSession('?chat-session=%20%20')).toBeNull();
    expect(readDetachedChatSession('?toast-evidence=error')).toBeNull();
  });

  it('builds a clean standalone URL without carrying evidence or fragments', () => {
    expect(
      detachedChatUrl(
        'https://relay.test/mobile?toast-evidence=error&tree-evidence=git#section',
        'session/one',
      ),
    ).toBe('https://relay.test/mobile?chat-session=session%2Fone');
  });

  it('uses a stable, opaque browsing-context name for each session', () => {
    expect(detachedChatWindowName('session/one')).toBe(detachedChatWindowName('session/one'));
    expect(detachedChatWindowName('session/one')).not.toBe(detachedChatWindowName('session/two'));
    expect(detachedChatWindowName('session/one')).not.toContain('session/one');
  });
});
