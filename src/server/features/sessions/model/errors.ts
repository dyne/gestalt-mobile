/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type DomainErrorCode =
  | 'INVALID_SESSION_VALUE'
  | 'SESSION_NOT_READY'
  | 'SESSION_TURN_ACTIVE'
  | 'TURN_NOT_ACTIVE'
  | 'INTERACTION_ALREADY_PENDING'
  | 'INTERACTION_NOT_PENDING';

export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode) {
    super(code);
    this.name = 'DomainError';
  }
}
