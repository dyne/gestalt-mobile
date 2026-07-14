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
