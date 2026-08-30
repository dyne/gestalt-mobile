/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FileChangeSummary } from './file-change.js';

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
/** Safe server-derived audit record. It intentionally contains no prompt, output, path, or stack. */
export type AutopilotAuditRecord = {
  id: string;
  label: string;
  occurredAt: number;
  controlId?: string;
};
/** Safe display-only activity restored independently of upstream Codex history. */
export type SafeActivitySnapshot = {
  id: string;
  label: string;
  detail: string;
  turnId?: string;
  /** Physical child turn retained only as bounded diagnostic identity. */
  actorTurnId?: string;
  occurredAt?: number;
  changes?: FileChangeSummary[];
};
export type SafeInteractionOutcome = 'approved' | 'denied' | 'answered' | 'dismissed' | 'failed';
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
  activities?: SafeActivitySnapshot[];
  autopilotAudit?: AutopilotAuditRecord[];
  /** The bounded audit tail omitted older records; the visible list is not exhaustive. */
  autopilotAuditTruncated?: boolean;
  baseSequence: number;
  currentSequence?: number;
};
