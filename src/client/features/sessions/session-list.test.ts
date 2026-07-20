/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { displayWorkspacePath, managedSessionDetails } from './session-list.js';

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

describe('displayWorkspacePath', () => {
  it('abbreviates a Linux home-directory prefix', () => {
    expect(displayWorkspacePath('/home/alice/projects/gestalt-mobile')).toBe(
      '~/projects/gestalt-mobile',
    );
    expect(displayWorkspacePath('/home/alice')).toBe('~/');
  });

  it('keeps paths outside a Linux home directory unchanged', () => {
    expect(displayWorkspacePath('/workspace/project')).toBe('/workspace/project');
  });
});
