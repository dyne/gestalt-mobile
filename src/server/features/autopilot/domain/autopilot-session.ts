/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type AutopilotState =
  'disabled' | 'monitoring' | 'backoff' | 'attentionRequired' | 'completed';

export type AutopilotStopReason =
  | 'manualDisabled'
  | 'planRequired'
  | 'planComplete'
  | 'sessionUnavailable'
  | 'attentionRequired'
  | 'noPlanProgress'
  | 'reconcileFailed'
  | 'planRemoved'
  | 'planReplaced'
  | 'sessionEnded';

/** Durable, session-owned control state. It intentionally excludes plan paths and prompt text. */
export type AutopilotSession = Readonly<{
  sessionId: string;
  state: AutopilotState;
  requestedEnabled: boolean;
  planIdentity: string | null;
  planFingerprint: string | null;
  generation: number;
  consecutiveNoProgress: number;
  nextEvaluationAt: string | null;
  lastControlId: string | null;
  stopReason: AutopilotStopReason | null;
  updatedAt: string;
}>;

export type AutopilotSnapshot = Readonly<{
  state: AutopilotState;
  enabled: boolean;
  reason?: AutopilotStopReason;
  retry: Readonly<{ position: number; limit: number }>;
  /** Opaque server control provenance; never prompt or conversation content. */
  lastAutomaticAction?: Readonly<{ controlId: string; summary: string }>;
  nextEvaluationAt?: string;
  updatedAt: string;
}>;

export function disabledAutopilot(sessionId: string, now: string): AutopilotSession {
  return {
    sessionId,
    state: 'disabled',
    requestedEnabled: false,
    planIdentity: null,
    planFingerprint: null,
    generation: 0,
    consecutiveNoProgress: 0,
    nextEvaluationAt: null,
    lastControlId: null,
    stopReason: 'manualDisabled',
    updatedAt: now,
  };
}

export function autopilotSnapshot(state: AutopilotSession, retryLimit: number): AutopilotSnapshot {
  return {
    state: state.state,
    enabled: state.requestedEnabled,
    ...(state.stopReason ? { reason: state.stopReason } : {}),
    retry: { position: state.consecutiveNoProgress, limit: retryLimit },
    ...(state.lastControlId
      ? {
          lastAutomaticAction: {
            controlId: state.lastControlId,
            summary:
              state.state === 'backoff'
                ? 'Automatic continuation scheduled.'
                : 'Automatic continuation issued.',
          },
        }
      : {}),
    ...(state.nextEvaluationAt ? { nextEvaluationAt: state.nextEvaluationAt } : {}),
    updatedAt: state.updatedAt,
  };
}
