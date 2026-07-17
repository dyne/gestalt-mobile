/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { stop } from './use-case.js';
describe('stop', () => {
  it('persists stopped desired state before child close', () =>
    expect(
      stop(
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
        'n',
      ),
    ).toMatchObject({ state: 'stopped', desiredState: 'stopped' }));
});
