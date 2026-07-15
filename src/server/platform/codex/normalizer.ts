import type { SessionEvent } from '../../../shared/contracts/session-event.js';

export function normalizeCodexNotification(
  sessionId: string,
  sequence: number,
  occurredAt: string,
  notification: { method?: string; params?: unknown },
): SessionEvent | null {
  if (notification.method === 'item/agentMessage/delta')
    return {
      sessionId,
      sequence,
      occurredAt,
      type: 'agentMessageDelta',
      payload: { text: (notification.params as { delta?: string } | undefined)?.delta ?? '' },
    };
  if (notification.method === 'turn/completed')
    return {
      sessionId,
      sequence,
      occurredAt,
      type: 'turnCompleted',
      payload: notification.params ?? {},
    };
  if (notification.method === 'item/started' || notification.method === 'item/completed') {
    const activity = safeActivity((notification.params as { item?: unknown } | undefined)?.item);
    if (activity)
      return { sessionId, sequence, occurredAt, type: 'activity.updated', payload: activity };
  }
  return null;
}

function safeActivity(item: unknown): { id: string; label: string; detail: string } | null {
  if (!item || typeof item !== 'object') return null;
  const value = item as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.type !== 'string') return null;
  const status = typeof value.status === 'string' ? ` · ${value.status}` : '';
  if (value.type === 'commandExecution' && typeof value.command === 'string')
    return { id: value.id, label: `Command${status}`, detail: value.command };
  if (value.type === 'plan' && typeof value.text === 'string')
    return { id: value.id, label: 'Plan', detail: value.text };
  if (value.type === 'reasoning' && Array.isArray(value.summary))
    return {
      id: value.id,
      label: 'Reasoning summary',
      detail: value.summary.filter((part): part is string => typeof part === 'string').join('\n'),
    };
  if (value.type === 'fileChange' && Array.isArray(value.changes))
    return {
      id: value.id,
      label: `File change${status}`,
      detail: value.changes
        .map((change) =>
          change &&
          typeof change === 'object' &&
          typeof (change as Record<string, unknown>).path === 'string'
            ? (change as Record<string, string>).path
            : '',
        )
        .filter(Boolean)
        .join('\n'),
    };
  if (
    (value.type === 'mcpToolCall' || value.type === 'dynamicToolCall') &&
    typeof value.tool === 'string'
  )
    return { id: value.id, label: `Tool${status}`, detail: value.tool };
  return null;
}
