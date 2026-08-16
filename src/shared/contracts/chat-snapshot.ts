/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ChatItem = {
  id: string;
  kind: string;
  text?: string;
  turnId?: string;
  occurredAt?: number;
  [key: string]: unknown;
};
export type ChatTurn = {
  id: string;
  items: ChatItem[];
  startedAt: number | null;
  completedAt: number | null;
};
export type SafeInteractionOutcome = 'approved' | 'denied' | 'answered' | 'dismissed';
export type SafeInteractionSnapshot =
  | {
      requestId: string;
      kind: string;
      turnId: string | null;
      requestedAt: string | null;
      resolvedAt: null;
      payload: unknown;
    }
  | {
      requestId: string;
      kind: string;
      turnId: string | null;
      requestedAt: string | null;
      resolvedAt: string;
      outcome: SafeInteractionOutcome;
    };
/** Lower-bound snapshot: events with sequence > baseSequence are replayable. */
export type ChatSnapshot = {
  items: ChatItem[];
  turns: ChatTurn[];
  activeTurnId: string | null;
  interactions: SafeInteractionSnapshot[];
  baseSequence: number;
  currentSequence?: number;
};
