/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  displayWorkspacePath,
  managedSessionDetails,
  retainForgottenSession,
} from './session-list.js';

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

describe('retainForgottenSession', () => {
  const forgotten = {
    id: 'relay-session',
    state: 'released',
    threadId: 'thread-forgotten',
    workspacePath: '/workspace/forgotten',
    resumeCommand: 'codex resume thread-forgotten',
    updatedAt: '2026-07-15T10:00:00.000Z',
  };

  it('keeps a forgotten managed thread in recency order when Codex omits it', () => {
    expect(
      retainForgottenSession(
        [
          {
            id: 'newer',
            cwd: '/workspace/newer',
            recencyAt: Date.UTC(2026, 6, 15, 11) / 1_000,
            resumeCommand: 'codex resume newer',
          },
          {
            id: 'older',
            cwd: '/workspace/older',
            recencyAt: Date.UTC(2026, 6, 15, 9) / 1_000,
            resumeCommand: 'codex resume older',
          },
        ],
        forgotten,
      ).map((session) => session.id),
    ).toEqual(['newer', 'thread-forgotten', 'older']);
  });

  it('prefers the Codex result and ignores sessions without resumable metadata', () => {
    const listed = [
      {
        id: 'thread-forgotten',
        cwd: '/workspace/from-codex',
        recencyAt: 1,
        resumeCommand: 'codex resume thread-forgotten',
      },
    ];
    expect(retainForgottenSession(listed, forgotten)).toBe(listed);
    expect(retainForgottenSession(listed, { id: 'unbound', state: 'failed' })).toBe(listed);
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
