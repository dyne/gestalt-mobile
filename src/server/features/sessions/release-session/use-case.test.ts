/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { release } from './use-case.js';
describe('release', () => {
  it('stops relay ownership but retains a thread', () =>
    expect(
      release(
        {
          id: 's',
          workspaceId: 'w',
          workspacePath: '/w',
          profile: 'default',
          threadId: 't',
          state: 'ready',
          desiredState: 'active',
          activeTurnId: null,
          protocolVersion: null,
          failureCount: 0,
          pendingInteractions: [],
          createdAt: 't',
          updatedAt: 't',
        },
        'now',
      ),
    ).toMatchObject({ state: 'released', desiredState: 'stopped', threadId: 't' }));
});
