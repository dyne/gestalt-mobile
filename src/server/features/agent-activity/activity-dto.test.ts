/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';
import { createAgentActivitySnapshot, projectAgentActivity } from './model.js';
import { toAgentActivityDto } from './activity-dto.js';

describe('agent activity DTO', () => {
  it('publishes bounded display evidence without runtime identifiers or metrics', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const snapshot = projectAgentActivity(createAgentActivitySnapshot('s', at), {
      sessionId: 's',
      occurredAt: at,
      kind: 'collaboration',
      childId: 'child',
      childTaskPath: '/root/l1_g2',
      childOwnedProcesses: [
        {
          processId: 'private',
          itemId: 'private-item',
          ownerThreadId: 'private-thread',
          ownerTaskPath: '/root/l1_g2',
          ownership: 'executor',
          state: 'running',
          observedAt: at,
          elapsedMs: 1,
          cpuPercent: 99,
          rssBytes: 99,
          osPid: 42,
          resultArtifact: 'private',
        },
      ],
    });
    const dto = JSON.stringify(toAgentActivityDto(snapshot));
    expect(dto).toContain('"canonicalPosition":"L1"');
    expect(dto).not.toMatch(/private|ownerThreadId|ownerTaskPath|cpuPercent|rssBytes|osPid/);
  });
});
