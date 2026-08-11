/*
 * Copyright (C) 2026 Dyne.org foundation
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ChatItem = {
  id: string;
  kind: string;
  text?: string;
  occurredAt?: number;
  [key: string]: unknown;
};
export type ChatTurn = {
  id: string;
  items: ChatItem[];
  startedAt: number | null;
  completedAt: number | null;
};
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
      outcome: 'approved' | 'denied' | 'answered';
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
