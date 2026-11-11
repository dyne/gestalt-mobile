/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ForgetPhase = 'stopping' | 'cleaning' | 'finalizing' | 'failed' | 'completed';
export type SessionForgetOperation = Readonly<{
  operationId: string;
  sessionId: string;
  phase: ForgetPhase;
  updatedAt: string;
  /** Forget completed while ownership checks retained disposable files. */
  scratchRetained?: true;
  failureCode?: 'SESSION_RELEASE_UNCONFIRMED' | 'SESSION_CLEANUP_FAILED' | 'SESSION_FORGET_FAILED';
}>;
