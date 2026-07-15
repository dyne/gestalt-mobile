import { describe, expect, it } from 'vitest';

import { managedSessionDetails } from './session-list.js';

describe('managedSessionDetails', () => {
  it('exposes the resumable thread ID, workspace path, and updated time', () => {
    expect(
      managedSessionDetails({
        threadId: 'thread-1',
        workspacePath: '/workspace/project',
        updatedAt: '2026-07-15T10:00:00.000Z',
      }),
    ).toEqual({
      threadId: 'thread-1',
      workspacePath: '/workspace/project',
      updatedAt: Date.UTC(2026, 6, 15, 10, 0, 0),
    });
  });

  it('keeps an unbound session identifiable without exposing the relay ID', () => {
    expect(
      managedSessionDetails({ threadId: null, workspacePath: '/workspace', updatedAt: 'bad' }),
    ).toEqual({
      threadId: null,
      workspacePath: '/workspace',
      updatedAt: null,
    });
  });
});
