/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const GESTALT_QUIZ_TOOL_NAME = 'gestalt_quiz';

export type QuizChoice = {
  label: string;
  description: string;
};

export type QuizQuestion = {
  id: string;
  header: string;
  question: string;
  choices: QuizChoice[];
  allowCustom: boolean;
  isSecret: boolean;
};

export type Quiz = {
  questions: QuizQuestion[];
};

export type QuizAnswer = {
  id: string;
  answer: string;
};

export type QuizResponse = {
  answers: Record<string, string>;
};

/**
 * The app-server descriptor is intentionally plain JSON so the session adapter
 * can register the same stable contract for new and resumed threads.
 */
export const gestaltQuizDynamicTool = {
  type: 'function',
  name: GESTALT_QUIZ_TOOL_NAME,
  description:
    'Ask the user one to eight bounded-choice quiz questions. Use this instead of writing a numbered-choice request in chat whenever you need the user to choose among defined options. Each question must include two to five choices and explicitly state whether a custom answer is allowed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'header', 'question', 'choices', 'allowCustom'],
          properties: {
            id: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[A-Za-z][A-Za-z0-9_-]*$',
            },
            header: { type: 'string', minLength: 1, maxLength: 120 },
            question: { type: 'string', minLength: 1, maxLength: 600 },
            choices: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'description'],
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 160 },
                  description: { type: 'string', minLength: 1, maxLength: 600 },
                },
              },
            },
            allowCustom: { type: 'boolean' },
            isSecret: { type: 'boolean' },
          },
        },
      },
    },
  },
} as const;

/** Parses the bounded payload that is safe to persist and render as a quiz. */
export function parseQuiz(value: unknown, minimumChoices = 2): Quiz | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) return null;
  if (value.questions.length < 1 || value.questions.length > 8) return null;

  const questions = value.questions.map((question) => parseQuestion(question, minimumChoices));
  if (questions.some((question) => question === null)) return null;
  const parsed = questions as QuizQuestion[];
  return new Set(parsed.map((question) => question.id)).size === parsed.length
    ? { questions: parsed }
    : null;
}

/** Maps Codex's experimental native request shape into the common quiz value. */
export function mapNativeUserInputToQuiz(value: unknown): Quiz | null {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length > 3)
    return null;
  return parseQuiz(
    {
      questions: value.questions.map((question) =>
        isRecord(question)
          ? {
              id: question.id,
              header: question.header,
              question: question.question,
              choices: question.options,
              allowCustom: question.isOther === true,
              isSecret: question.isSecret === true,
            }
          : question,
      ),
    },
    1,
  );
}

/** Converts a completed quiz into the app-server dynamic-tool response shape. */
export function toQuizToolResponse(answers: QuizAnswer[]): {
  contentItems: Array<{ type: 'inputText'; text: string }>;
  success: true;
} {
  return {
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify({
          answers: Object.fromEntries(
            answers
              .filter((answer) => answer.answer.trim())
              .map((answer) => [answer.id, answer.answer]),
          ),
        }),
      },
    ],
    success: true,
  };
}

export function isQuizToolResponseForQuiz(quiz: Quiz, value: unknown): boolean {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.contentItems))
    return false;
  const item = value.contentItems[0];
  if (
    value.contentItems.length !== 1 ||
    !isRecord(item) ||
    item.type !== 'inputText' ||
    typeof item.text !== 'string'
  )
    return false;
  try {
    const response = parseQuizResponse(JSON.parse(item.text));
    return response !== null && isCompleteQuizResponse(quiz, response);
  } catch {
    return false;
  }
}

function parseQuestion(value: unknown, minimumChoices: number): QuizQuestion | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.choices) ||
    value.choices.length < minimumChoices ||
    value.choices.length > 5
  )
    return null;
  if (
    !isQuestionId(value.id) ||
    !isBoundedText(value.header, 120) ||
    !isBoundedText(value.question, 600)
  )
    return null;
  if (typeof value.allowCustom !== 'boolean') return null;

  const choices = value.choices.map(parseChoice);
  if (choices.some((choice) => choice === null)) return null;
  return {
    id: value.id,
    header: value.header,
    question: value.question,
    choices: choices as QuizChoice[],
    allowCustom: value.allowCustom,
    isSecret: value.isSecret === true,
  };
}

function parseChoice(value: unknown): QuizChoice | null {
  if (
    !isRecord(value) ||
    !isBoundedText(value.label, 160) ||
    !isBoundedText(value.description, 600)
  )
    return null;
  return { label: value.label, description: value.description };
}

function parseQuizResponse(value: unknown): QuizResponse | null {
  if (!isRecord(value) || !isRecord(value.answers)) return null;
  const entries = Object.entries(value.answers);
  if (
    entries.length === 0 ||
    entries.some(([id, answer]) => !isQuestionId(id) || !isBoundedText(answer, 2_000))
  )
    return null;
  return { answers: Object.fromEntries(entries) as Record<string, string> };
}

function isCompleteQuizResponse(quiz: Quiz, response: QuizResponse): boolean {
  const ids = Object.keys(response.answers);
  if (
    ids.length !== quiz.questions.length ||
    ids.some((id) => !quiz.questions.some((question) => question.id === id))
  )
    return false;
  return quiz.questions.every((question) => {
    const answer = response.answers[question.id];
    return (
      typeof answer === 'string' &&
      (question.allowCustom || question.choices.some((choice) => choice.label === answer))
    );
  });
}

function isQuestionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
