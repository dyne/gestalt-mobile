/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export class WorkspaceSessionConflict extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code:
      'SESSION_WORKSPACE_BUSY' | 'SESSION_WORKSPACE_CLEANING' | 'SESSION_NESTED_WORKSPACE',
    readonly sessionId: string,
  ) {
    super(
      code === 'SESSION_WORKSPACE_BUSY'
        ? 'A session is already running in this workspace. Open that session or stop it first.'
        : code === 'SESSION_NESTED_WORKSPACE'
          ? 'Forget the session whose workspace is inside this temporary directory first.'
          : 'This workspace is being forgotten. Retry when cleanup finishes.',
    );
  }
}
