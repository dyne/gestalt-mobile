/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ChatMessage } from './message-store.js';

export type MessageGroup =
  | { id: string; kind: 'user'; text: string; occurredAt?: number }
  | {
      id: string;
      kind: 'assistant';
      commentary: string | null;
      answer: string | null;
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
      ...(commentary.at(-1)?.occurredAt ? { occurredAt: commentary.at(-1)!.occurredAt } : {}),
    });
    commentary = [];
  };

  for (const message of messages) {
    if (message.role === 'user') {
      addCommentary();
      groups.push({
        id: message.id,
        kind: 'user',
        text: message.text,
        ...(message.occurredAt ? { occurredAt: message.occurredAt } : {}),
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
      ...(message.occurredAt ? { occurredAt: message.occurredAt } : {}),
    });
    commentary = [];
  }
  addCommentary();
  return groups;
}
