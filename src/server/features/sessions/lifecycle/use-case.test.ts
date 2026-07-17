/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { releaseSession, restoreSession, stopSession } from './use-case.js';

const session = {
  id: 's',
  workspaceId: 'w',
  workspacePath: '/w',
  profile: 'default',
  threadId: 't',
  state: 'ready' as const,
  desiredState: 'active' as const,
  activeTurnId: null,
  protocolVersion: null,
  failureCount: 0,
  pendingInteractions: [],
  createdAt: 't',
  updatedAt: 't',
};
describe('session lifecycle', () => {
  it('sets explicit stopped desired state', () => {
    expect(stopSession(session, 'n').state).toBe('stopped');
    expect(releaseSession(session, 'n').state).toBe('released');
    expect(restoreSession(session, 'n').state).toBe('ready');
  });
});
