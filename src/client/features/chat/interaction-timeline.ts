/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mapNativeUserInputToQuiz, parseQuiz } from '../../../shared/contracts/quiz.js';
import type { OrgPlanAttention } from '../autopilot/contracts.js';
import type { ProjectedInteraction } from './chat-projection.js';
import type { ChatMessage } from './message-store.js';
import { formatQuizAnswerPrompt, type SubmittedQuizAnswer } from './quiz-submission.js';

export function visibleInteraction(item: ProjectedInteraction): boolean {
  return !['orgPlanAttention', 'orgPlanCheckpoint', 'autopilotWaitLease'].includes(item.kind);
}

/** Only exact repeated paragraphs from the same turn are owned by a dialogue.
 * Keep unrelated explanations and never change the stored conversation. */
export function withoutDialogueEchoes(
  messages: readonly ChatMessage[],
  interactions: readonly ProjectedInteraction[],
  attention: readonly OrgPlanAttention[],
  submittedAnswers: Record<string, readonly SubmittedQuizAnswer[]> = {},
): ChatMessage[] {
  const paragraphs = new Map<string, Set<string>>();
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');
  const add = (turnId: string | null | undefined, text: string | undefined) => {
    if (!turnId || !text?.trim()) return;
    const values = paragraphs.get(turnId) ?? new Set<string>();
    values.add(normalize(text));
    paragraphs.set(turnId, values);
  };
  for (const item of attention) {
    add(item.turnId, item.supervisorReport);
    add(item.turnId, item.attention.summary);
    add(item.turnId, item.attention.requestedAction);
  }
  for (const item of interactions) {
    // A resolved quiz with no retained payload cannot own a question's content.
    const quiz =
      item.kind === 'quiz'
        ? parseQuiz(item.payload)
        : item.kind === 'userInput'
          ? mapNativeUserInputToQuiz(item.payload)
          : null;
    for (const question of quiz?.questions ?? []) add(item.turnId, question.question);
  }
  return messages.flatMap((message) => {
    if (
      message.role === 'user' &&
      interactions.some(
        (item) =>
          submittedAnswers[item.requestId]?.length &&
          normalize(message.text) ===
            normalize(formatQuizAnswerPrompt(submittedAnswers[item.requestId]!)),
      )
    )
      return [];
    const owned =
      message.turnId && message.role === 'assistant' ? paragraphs.get(message.turnId) : null;
    if (!owned) return [message];
    const text = owned.has(normalize(message.text))
      ? ''
      : message.text
          .split(/\n\s*\n/)
          .filter((part) => !owned.has(normalize(part)))
          .join('\n\n');
    return text.trim() ? [{ ...message, text }] : [];
  });
}
