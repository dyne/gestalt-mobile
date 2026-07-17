/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { buildResumeCommand } from './resume-command.js';

describe('buildResumeCommand', () => {
  it('quotes every shell argument', () => {
    expect(
      buildResumeCommand({
        id: 's',
        workspaceId: 'w',
        workspacePath: "/a b/it's",
        profile: 'default',
        threadId: 't',
        state: 'released',
        desiredState: 'stopped',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 't',
        updatedAt: 't',
      }),
    ).toContain("'/a b/it'\"'\"'s'");
  });
});
