export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string; phase?: 'commentary' | 'final_answer' }
  | { id: string; kind: 'reasoning'; summary: string[] }
  | { id: string; kind: 'plan'; text: string }
  | { id: string; kind: 'command'; command: string; status: string; exitCode?: number }
  | { id: string; kind: 'fileChange'; paths: string[]; status: string }
  | { id: string; kind: 'tool'; name: string; status: string };

export function toChatItems(items: Array<Record<string, unknown>>): ChatItem[] {
  return items.flatMap<ChatItem>((item) => {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) return [];
    switch (item.type) {
      case 'userMessage': {
        const text = Array.isArray(item.content)
          ? item.content
              .filter(isRecord)
              .filter((part) => part.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\n')
          : '';
        return text ? [{ id, kind: 'user', text }] : [];
      }
      case 'agentMessage':
        return typeof item.text === 'string'
          ? [
              {
                id,
                kind: 'agent',
                text: item.text,
                ...(item.phase === 'commentary' || item.phase === 'final' 
                  ? { phase: item.phase === 'final' ? 'final_answer' : 'commentary' }
                  : {}),
              },
            ]
          : [];
      case 'reasoning':
        return Array.isArray(item.summary) && item.summary.every((part) => typeof part === 'string')
          ? [{ id, kind: 'reasoning', summary: item.summary }]
          : [];
      case 'plan':
        return typeof item.text === 'string' ? [{ id, kind: 'plan', text: item.text }] : [];
      case 'commandExecution':
        return typeof item.command === 'string' && typeof item.status === 'string'
          ? [{ id, kind: 'command', command: item.command, status: item.status, ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}) }]
          : [];
      default:
        return [];
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
