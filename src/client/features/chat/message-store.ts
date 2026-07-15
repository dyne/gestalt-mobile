export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  phase?: 'commentary' | 'final_answer';
  text: string;
  occurredAt?: number;
  complete: boolean;
};

export function appendUserMessage(
  messages: ChatMessage[],
  id: string,
  text: string,
  occurredAt?: number,
): ChatMessage[] {
  return [
    ...messages,
    { id, role: 'user', text, ...(occurredAt ? { occurredAt } : {}), complete: true },
  ];
}

export function applyDelta(
  messages: ChatMessage[],
  id: string,
  text: string,
  occurredAt?: number,
): ChatMessage[] {
  const previous = messages.find((message) => message.id === id);
  return previous
    ? messages.map((message) =>
        message.id === id ? { ...message, text: message.text + text } : message,
      )
    : [
        ...messages,
        {
          id,
          role: 'assistant',
          phase: 'commentary',
          text,
          ...(occurredAt ? { occurredAt } : {}),
          complete: false,
        },
      ];
}

export function completeMessage(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.map((message) => (message.id === id ? { ...message, complete: true } : message));
}
