/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { isDeepStrictEqual } from 'node:util';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';

/** Mutable Relay metadata may advance while Native reconfiguration is pending.
 * Provider, selected settings and permissions may never change in that interval. */
export function currentOwningSession(
  baseline: RelaySessionSnapshot,
  current: RelaySessionSnapshot | null,
): RelaySessionSnapshot {
  if (
    !current ||
    [
      'id',
      'provider',
      'workspaceId',
      'workspacePath',
      'threadId',
      'profile',
      'model',
      'modelSettings',
      'executionPolicy',
      'effectiveSkillSelection',
    ].some(
      (key) =>
        !isDeepStrictEqual(
          baseline[key as keyof RelaySessionSnapshot],
          current[key as keyof RelaySessionSnapshot],
        ),
    )
  )
    throw new Error('LIVE_RELAY_AUTHORIZATION_CHANGED');
  return structuredClone(current);
}
/** Publish only actual replacement lifecycle results, retaining the current plan,
 * debug and branch metadata rather than replaying a pre-Live session snapshot. */
export function recoveredSession(
  current: RelaySessionSnapshot,
  restored: RelaySessionSnapshot,
): RelaySessionSnapshot {
  currentOwningSession(current, restored);
  if (
    restored.state !== 'ready' ||
    restored.desiredState !== 'active' ||
    restored.activeTurnId ||
    restored.pendingInteractions.length
  )
    throw new Error('LIVE_RELAY_RECOVERY_UNVERIFIED');
  const restoredAt = Date.parse(restored.updatedAt),
    currentAt = Date.parse(current.updatedAt);
  return {
    ...structuredClone(current),
    state: restored.state,
    desiredState: restored.desiredState,
    activeTurnId: restored.activeTurnId,
    pendingInteractions: structuredClone(restored.pendingInteractions),
    protocolVersion: restored.protocolVersion,
    ...(restored.attentionToolCapability
      ? { attentionToolCapability: restored.attentionToolCapability }
      : {}),
    failureCount: restored.failureCount,
    updatedAt:
      Number.isFinite(restoredAt) && restoredAt >= currentAt
        ? restored.updatedAt
        : current.updatedAt,
  };
}
