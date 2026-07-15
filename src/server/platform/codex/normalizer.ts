import type { SessionEvent } from '../../../shared/contracts/session-event.js';
import { relative } from 'node:path';

export function normalizeCodexNotification(
  sessionId: string,
  sequence: number,
  occurredAt: string,
  notification: { method?: string; params?: unknown },
  workspacePath?: string,
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
    const activity = safeActivity(
      (notification.params as { item?: unknown } | undefined)?.item,
      workspacePath,
    );
    if (activity)
      return { sessionId, sequence, occurredAt, type: 'activity.updated', payload: activity };
  }
  return null;
}

function safeActivity(
  item: unknown,
  workspacePath?: string,
): { id: string; label: string; detail: string } | null {
  if (!item || typeof item !== 'object') return null;
  const value = item as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.type !== 'string') return null;
  const status = typeof value.status === 'string' ? ` · ${value.status}` : '';
  if (value.type === 'commandExecution' && typeof value.command === 'string')
    return { id: value.id, label: `Command${status}`, detail: value.command };
  if (value.type === 'plan' && typeof value.text === 'string')
    return { id: value.id, label: 'Plan', detail: value.text };
  if (value.type === 'reasoning' && Array.isArray(value.summary)) {
    const detail = reasoningSummary(value.summary).join('\n');
    return detail ? { id: value.id, label: 'Reasoning summary', detail } : null;
  }
  if (value.type === 'fileChange' && Array.isArray(value.changes))
    return {
      id: value.id,
      label: `fileChange${status}`,
      detail: value.changes
        .map((change) =>
          change &&
          typeof change === 'object' &&
          typeof (change as Record<string, unknown>).path === 'string'
            ? relativePath((change as Record<string, string>).path, workspacePath)
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

function relativePath(path: string, workspacePath?: string): string {
  if (!workspacePath) return path;
  const value = relative(workspacePath, path);
  return value && !value.startsWith('..') ? value : path;
}

function reasoningSummary(parts: unknown[]): string[] {
  return parts.flatMap((part) => {
    if (typeof part === 'string') return part ? [part] : [];
    if (
      part &&
      typeof part === 'object' &&
      (part as Record<string, unknown>).type === 'summary_text' &&
      typeof (part as Record<string, unknown>).text === 'string'
    )
      return [(part as Record<string, string>).text];
    return [];
  });
}
