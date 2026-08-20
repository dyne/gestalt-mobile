/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ChatMessage } from './message-store.js';

export type MessageGroup =
  | { id: string; kind: 'user'; text: string; turnId?: string; occurredAt?: number }
  | {
      id: string;
      kind: 'audit';
      text: string;
      controlId?: string;
      retryFamily?: string;
      occurredAt?: number;
      count: number;
      timestamps: readonly number[];
    }
  | {
      id: string;
      kind: 'assistant';
      commentary: string | null;
      answer: string | null;
      turnId?: string;
      occurredAt?: number;
    };

export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let commentary: ChatMessage[] = [];

  const addCommentary = () => {
    if (!commentary.length) return;
    groups.push({
      id: commentary.at(-1)!.id,
      kind: 'assistant',
      commentary: commentary.map((message) => message.text).join('\n\n'),
      answer: null,
      ...(commentary.at(-1)?.turnId ? { turnId: commentary.at(-1)!.turnId } : {}),
      ...(commentary.at(-1)?.occurredAt !== undefined
        ? { occurredAt: commentary.at(-1)!.occurredAt }
        : {}),
    });
    commentary = [];
  };

  for (const message of messages) {
    if (message.role === 'audit') {
      addCommentary();
      const family = retryFamily(message.text);
      const previous = groups.at(-1);
      if (
        previous?.kind === 'audit' &&
        family !== null &&
        previous.retryFamily === family &&
        message.occurredAt !== undefined &&
        (previous.timestamps.at(-1) ?? Number.NEGATIVE_INFINITY) < message.occurredAt
      ) {
        previous.count += 1;
        if (message.occurredAt !== undefined)
          previous.timestamps = [...previous.timestamps, message.occurredAt];
        continue;
      }
      groups.push({
        id: message.id,
        kind: 'audit',
        text: message.text,
        ...(message.controlId ? { controlId: message.controlId } : {}),
        ...(family ? { retryFamily: family } : {}),
        ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}),
        count: 1,
        timestamps: message.occurredAt === undefined ? [] : [message.occurredAt],
      });
      continue;
    }
    if (message.role === 'user') {
      addCommentary();
      groups.push({
        id: message.id,
        kind: 'user',
        text: message.text,
        ...(message.turnId ? { turnId: message.turnId } : {}),
        ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}),
      });
      continue;
    }
    if (message.phase === 'commentary') {
      commentary.push(message);
      continue;
    }
    groups.push({
      id: message.id,
      kind: 'assistant',
      commentary: commentary.length ? commentary.map((item) => item.text).join('\n\n') : null,
      answer: message.text,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}),
    });
    commentary = [];
  }
  addCommentary();
  return groups;
}

/** Retry attempts receive distinct durable control IDs but share a coordinator stage. */
function retryFamily(text: string): string | null {
  if (text === 'Autopilot scheduled a continuation') return 'continuation-scheduled';
  if (text === 'Autopilot issued an automatic continuation.') return 'continuation-issued';
  if (text === 'Autopilot continuation started') return 'continuation-started';
  if (text === 'Autopilot continuation failed') return 'continuation-failed';
  if (text === 'Autopilot is backing off') return 'continuation-backoff';
  return null;
}
