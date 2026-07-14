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
