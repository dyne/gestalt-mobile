/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { visibleHeaderActions, type ContextualHeaderAction } from './header-actions.js';
import type { RelaySession } from './relay-client.js';

const session: RelaySession = {
  id: 's',
  workspaceId: 'w',
  profile: 'default',
  state: 'ready',
  threadId: 'real-thread',
};
const debug: ContextualHeaderAction = {
  id: 'debug',
  label: 'DEBUG',
  tab: 'chat',
  available: (value) => Boolean(value.threadId),
  run: () => {},
};
describe('contextual header actions', () => {
  it('offers DEBUG for any existing selected Chat, including saved sessions', () => {
    for (const state of ['ready', 'turnActive', 'stopped', 'released', 'attentionRequired'])
      expect(visibleHeaderActions([debug], 'chat', { ...session, state })).toEqual([debug]);
  });
  it('hides session actions on other tabs and for absent or draft sessions', () => {
    expect(visibleHeaderActions([debug], 'sessions', session)).toEqual([]);
    expect(visibleHeaderActions([debug], 'chat', null)).toEqual([]);
    expect(visibleHeaderActions([debug], 'chat', { ...session, threadId: null })).toEqual([]);
  });
  it('supports additional actions restricted to a particular session state', () => {
    const idle: ContextualHeaderAction = {
      ...debug,
      id: 'idle',
      available: (value) => value.state === 'ready',
    };
    expect(visibleHeaderActions([idle], 'chat', session)).toEqual([idle]);
    expect(visibleHeaderActions([idle], 'chat', { ...session, state: 'turnActive' })).toEqual([]);
  });
});
