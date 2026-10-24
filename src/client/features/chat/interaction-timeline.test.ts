/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { withoutDialogueEchoes } from './interaction-timeline.js';
import type { ChatMessage } from './message-store.js';
import { formatQuizAnswerPrompt } from './quiz-submission.js';

describe('dialogue echo ownership', () => {
  const attention = {
    requestId: 'a',
    turnId: 'turn',
    requestedAt: null,
    supervisorReport: '**Missing** [dependency](/workspace/tool.ts:2)',
    attention: {
      reason: 'missingDependency',
      summary: 'A dependency is missing.',
      requestedAction: 'Install it.',
      resumeCondition: 'dependencyInstalled',
    },
  };
  it('suppresses exact same-turn paragraphs while preserving context and other turns', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        turnId: 'turn',
        text: `Extra context.\n\n${attention.supervisorReport}`,
        complete: true,
      },
      {
        id: 'b',
        role: 'assistant',
        turnId: 'other',
        text: attention.supervisorReport,
        complete: true,
      },
      { id: 'c', role: 'user', turnId: 'turn', text: attention.supervisorReport, complete: true },
      {
        id: 'd',
        role: 'assistant',
        turnId: 'turn',
        text: `${attention.supervisorReport} Additional detail.`,
        complete: true,
      },
    ];
    const before = structuredClone(messages);
    expect(withoutDialogueEchoes(messages, [], [attention]).map((item) => item.text)).toEqual([
      'Extra context.',
      attention.supervisorReport,
      attention.supervisorReport,
      `${attention.supervisorReport} Additional detail.`,
    ]);
    expect(messages).toEqual(before);
  });
  it('hides a submitted-answer echo only while a visible submitted transcript owns it', () => {
    const answers = [{ id: 'q', header: 'Choice', question: 'Proceed?', answer: 'Yes' }];
    const messages: ChatMessage[] = [
      { id: 'u', role: 'user', text: formatQuizAnswerPrompt(answers), complete: true },
    ];
    const interactions = [
      { requestId: 'q', key: 'q', kind: 'quiz', payload: null, state: 'resolved' as const },
    ];
    expect(withoutDialogueEchoes(messages, interactions, [], { q: answers })).toEqual([]);
    expect(withoutDialogueEchoes(messages, interactions, [], {})).toEqual(messages);
  });
});
