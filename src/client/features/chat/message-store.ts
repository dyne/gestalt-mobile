export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  complete: boolean;
};
export function applyDelta(messages: ChatMessage[], id: string, text: string): ChatMessage[] {
  const previous = messages.find((message) => message.id === id);
  return previous
    ? messages.map((message) =>
        message.id === id ? { ...message, text: message.text + text } : message,
      )
    : [...messages, { id, role: 'assistant', text, complete: false }];
}

export function completeMessage(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.map((message) => (message.id === id ? { ...message, complete: true } : message));
}
