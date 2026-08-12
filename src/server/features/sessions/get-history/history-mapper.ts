/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

type TurnOwned = { turnId?: string };

export type ChatItem =
  | ({
      id: string;
      kind: 'user';
      text: string;
      operationId?: string;
      occurredAt?: number;
    } & TurnOwned)
  | ({
      id: string;
      kind: 'agent';
      text: string;
      phase?: 'commentary' | 'final_answer';
      occurredAt?: number;
    } & TurnOwned)
  | ({ id: string; kind: 'reasoning'; summary: string[] } & TurnOwned)
  | ({ id: string; kind: 'plan'; text: string } & TurnOwned)
  | ({
      id: string;
      kind: 'command';
      command: string;
      status: string;
      exitCode?: number;
    } & TurnOwned)
  | ({ id: string; kind: 'fileChange'; paths: string[]; status: string } & TurnOwned)
  | ({ id: string; kind: 'tool'; name: string; status: string } & TurnOwned);

export type HistoryTurn = {
  id?: string;
  items: Array<Record<string, unknown>>;
  startedAt: number | null;
  completedAt: number | null;
};

/** Canonical grouping preserves the upstream Codex turn identity across reloads. */
export function toChatTurns(
  turns: HistoryTurn[],
): Array<{ id: string; items: ChatItem[]; startedAt: number | null; completedAt: number | null }> {
  return turns.map((turn, index) => {
    const turnId = turn.id ?? `history-turn-${index}`;
    return {
      id: turnId,
      items: turn.items.flatMap((item) => toChatItem(item, occurredAt(item, turn), turnId)),
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
    };
  });
}

export function toChatItems(turns: HistoryTurn[]): ChatItem[] {
  return turns.flatMap((turn, index) =>
    turn.items.flatMap((item) =>
      toChatItem(item, occurredAt(item, turn), turn.id ?? `history-turn-${index}`),
    ),
  );
}

function toChatItem(
  item: Record<string, unknown>,
  timestamp: number | undefined,
  turnId: string | undefined,
): ChatItem[] {
  const owner = turnId ? { turnId } : {};
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
          ? [
              {
                id,
                kind: 'user',
                text,
                ...owner,
                ...(typeof item.clientId === 'string' ? { operationId: item.clientId } : {}),
                ...(timestamp ? { occurredAt: timestamp } : {}),
              },
            ]
          : [];
      }
      case 'agentMessage':
        return typeof item.text === 'string'
          ? [
              {
                id,
                kind: 'agent',
                text: item.text,
                ...owner,
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
        return summary.length
          ? [
              {
                id,
                kind: 'reasoning',
                summary,
                ...owner,
                ...(timestamp ? { occurredAt: timestamp } : {}),
              },
            ]
          : [];
      case 'plan':
        return typeof item.text === 'string'
          ? [
              {
                id,
                kind: 'plan',
                text: item.text,
                ...owner,
                ...(timestamp ? { occurredAt: timestamp } : {}),
              },
            ]
          : [];
      case 'commandExecution':
        return typeof item.command === 'string' && typeof item.status === 'string'
          ? [
              {
                id,
                kind: 'command',
                command: item.command,
                status: item.status,
                ...owner,
                ...(timestamp ? { occurredAt: timestamp } : {}),
                ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
              },
            ]
          : [];
      case 'fileChange': {
        if (!Array.isArray(item.changes) || typeof item.status !== 'string') return [];
        const paths = item.changes.flatMap((change) =>
          isRecord(change) && typeof change.path === 'string' ? [change.path] : [],
        );
        return paths.length
          ? [
              {
                id,
                kind: 'fileChange',
                paths,
                status: item.status,
                ...owner,
                ...(timestamp ? { occurredAt: timestamp } : {}),
              },
            ]
          : [];
      }
      case 'mcpToolCall':
      case 'dynamicToolCall':
        return typeof item.tool === 'string' && typeof item.status === 'string'
          ? [
              {
                id,
                kind: 'tool',
                name: item.tool,
                status: item.status,
                ...owner,
                ...(timestamp ? { occurredAt: timestamp } : {}),
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
