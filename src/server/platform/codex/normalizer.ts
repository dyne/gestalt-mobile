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
  return null;
}
