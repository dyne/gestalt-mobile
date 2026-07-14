import { describe, expect, it } from 'vitest';
import { startSession } from './use-case.js';

describe('startSession', () => {
  it('creates and persists a starting session', async () => {
    const saved: unknown[] = [];
    const result = await startSession(
      { workspaceId: 'w', workspacePath: '/w', profile: 'default' },
      { createId: () => 's', now: () => 't', save: (session) => saved.push(session) },
    );
    expect(result.id).toBe('s');
    expect(saved).toHaveLength(1);
  });
});
