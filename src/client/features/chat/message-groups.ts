import type { ChatMessage } from './message-store.js';

export type MessageGroup =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; commentary: string | null; answer: string | null };

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
    });
    commentary = [];
  };

  for (const message of messages) {
    if (message.role === 'user') {
      addCommentary();
      groups.push({ id: message.id, kind: 'user', text: message.text });
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
    });
    commentary = [];
  }
  addCommentary();
  return groups;
}
