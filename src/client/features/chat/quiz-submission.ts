/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type SubmittedQuizAnswer = Readonly<{
  id: string;
  header: string;
  question: string;
  answer: string;
}>;

export function formatQuizAnswerPrompt(answers: readonly SubmittedQuizAnswer[]): string {
  return [
    'Submitted quiz answers:',
    ...answers.map(
      (answer) =>
        `- ${answer.header} — ${answer.question}\n  ${answer.answer.trim().replaceAll('\n', '\n  ')}`,
    ),
  ].join('\n');
}
