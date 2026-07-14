export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }>;
};

export function readUserInputQuestions(payload: unknown): UserInputQuestion[] {
  if (!isRecord(payload) || !Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((question) => {
    if (
      !isRecord(question) ||
      typeof question.id !== 'string' ||
      typeof question.header !== 'string' ||
      typeof question.question !== 'string'
    )
      return [];
    return [
      {
        id: question.id,
        header: question.header,
        question: question.question,
        isSecret: question.isSecret === true,
        options: Array.isArray(question.options)
          ? question.options.flatMap((option) =>
              isRecord(option) &&
              typeof option.label === 'string' &&
              typeof option.description === 'string'
                ? [{ label: option.label, description: option.description }]
                : [],
            )
          : [],
      },
    ];
  });
}

export function toUserInputResponse(answers: Array<{ id: string; answer: string }>): {
  answers: Record<string, { answers: string[] }>;
} {
  return {
    answers: Object.fromEntries(
      answers.filter((answer) => answer.answer.trim()).map((answer) => [answer.id, { answers: [answer.answer] }]),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
