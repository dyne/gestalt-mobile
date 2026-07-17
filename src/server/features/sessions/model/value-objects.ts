/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DomainError } from './errors.js';

function required(value: string): string {
  if (!value.trim()) throw new DomainError('INVALID_SESSION_VALUE');
  return value;
}

export const sessionId = (value: string) => required(value);
export const workspaceId = (value: string) => required(value);
export const workspacePath = (value: string) => {
  if (!value.startsWith('/')) throw new DomainError('INVALID_SESSION_VALUE');
  return required(value);
};
export const profileName = (value: string) => required(value);
export const threadId = (value: string) => required(value);
export const turnId = (value: string) => required(value);
export const interactionId = (value: string) => required(value);
