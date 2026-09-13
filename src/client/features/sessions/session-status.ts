/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySession } from './relay-client.js';

export function isSessionStatus(
  value: unknown,
): value is NonNullable<RelaySession['sessionStatus']> {
  if (!value || typeof value !== 'object') return false;
  const status = value as Record<string, unknown>;
  return (
    (status.state === 'working' || status.state === 'idle') &&
    [
      'needsYou',
      'complete',
      'rootTurn',
      'agent',
      'process',
      'autopilot',
      'incompleteWithoutContinuation',
      'stopped',
      'disconnected',
      'unknown',
    ].includes(status.reason as string) &&
    ['fresh', 'stale', 'reconciling'].includes(status.confidence as string) &&
    typeof status.observedAt === 'string' &&
    !Number.isNaN(Date.parse(status.observedAt)) &&
    typeof status.nextExpectedAction === 'string' &&
    status.nextExpectedAction.length > 0 &&
    status.nextExpectedAction.length <= 240
  );
}
