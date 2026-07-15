export type ChatItem =
  | { id: string; kind: 'user'; text: string; occurredAt?: number }
  | {
      id: string;
      kind: 'agent';
      text: string;
      phase?: 'commentary' | 'final_answer';
      occurredAt?: number;
    }
  | { id: string; kind: 'reasoning'; summary: string[] }
  | { id: string; kind: 'plan'; text: string }
  | { id: string; kind: 'command'; command: string; status: string; exitCode?: number }
  | { id: string; kind: 'fileChange'; paths: string[]; status: string }
  | { id: string; kind: 'tool'; name: string; status: string };

export type HistoryTurn = {
  items: Array<Record<string, unknown>>;
  startedAt: number | null;
  completedAt: number | null;
};

export function toChatItems(turns: HistoryTurn[]): ChatItem[] {
  return turns.flatMap((turn) =>
    turn.items.flatMap((item) => toChatItem(item, occurredAt(item, turn))),
  );
}

function toChatItem(item: Record<string, unknown>, timestamp: number | undefined): ChatItem[] {
  return [item].flatMap<ChatItem>((item) => {
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
        return text
          ? [{ id, kind: 'user', text, ...(timestamp ? { occurredAt: timestamp } : {}) }]
          : [];
      }
      case 'agentMessage':
        return typeof item.text === 'string'
          ? [
              {
                id,
                kind: 'agent',
                text: item.text,
                ...(item.phase === 'commentary' || item.phase === 'final_answer'
                  ? { phase: item.phase }
                  : {}),
                ...(timestamp ? { occurredAt: timestamp } : {}),
              },
            ]
          : [];
      case 'reasoning':
        if (!Array.isArray(item.summary)) return [];
        const summary = reasoningSummary(item.summary);
        return summary.length ? [{ id, kind: 'reasoning', summary }] : [];
      case 'plan':
        return typeof item.text === 'string' ? [{ id, kind: 'plan', text: item.text }] : [];
      case 'commandExecution':
        return typeof item.command === 'string' && typeof item.status === 'string'
          ? [
              {
                id,
                kind: 'command',
                command: item.command,
                status: item.status,
                ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
              },
            ]
          : [];
      default:
        return [];
    }
  });
}

function occurredAt(item: Record<string, unknown>, turn: HistoryTurn): number | undefined {
  const seconds =
    item.type === 'agentMessage' && item.phase === 'final_answer'
      ? (turn.completedAt ?? turn.startedAt)
      : turn.startedAt;
  return typeof seconds === 'number' ? seconds * 1_000 : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function reasoningSummary(parts: unknown[]): string[] {
  return parts.flatMap((part) => {
    if (typeof part === 'string') return part ? [part] : [];
    if (isRecord(part) && part.type === 'summary_text' && typeof part.text === 'string')
      return part.text ? [part.text] : [];
    return [];
  });
}
