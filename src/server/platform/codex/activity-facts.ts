/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivityFact } from '../../features/agent-activity/model.js';

const id = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Decodes only bounded app-server evidence; unsupported shapes deliberately become no fact. */
export function decodeAgentActivityFact(
  sessionId: string,
  occurredAt: string,
  input: { method?: string; params?: unknown },
): AgentActivityFact | null {
  const params = record(input.params);
  if (!params) return null;
  if (input.method === 'thread/started') {
    const thread = record(params.thread);
    const status = record(thread?.status);
    return id(thread?.id)
      ? {
          sessionId,
          occurredAt,
          kind: 'threadStarted',
          threadId: id(thread?.id),
          ...(typeof status?.type === 'string' ? { status: status.type } : {}),
        }
      : null;
  }
  if (input.method === 'thread/status/changed') {
    const status = record(params.status);
    return id(params.threadId) && typeof status?.type === 'string' && status.type.length <= 64
      ? {
          sessionId,
          occurredAt,
          kind: 'threadStatus',
          threadId: id(params.threadId),
          status: status.type,
        }
      : null;
  }
  if (input.method === 'turn/started')
    return id(params.threadId)
      ? {
          sessionId,
          occurredAt,
          kind: 'turnStarted',
          threadId: id(params.threadId),
          turnId: id(record(params.turn)?.id),
        }
      : null;
  if (input.method === 'turn/completed')
    return id(record(params.turn)?.id)
      ? {
          sessionId,
          occurredAt,
          kind: 'turnCompleted',
          threadId: id(params.threadId),
          turnId: id(record(params.turn)?.id),
          status:
            typeof record(params.turn)?.status === 'string'
              ? (record(params.turn)?.status as string)
              : undefined,
        }
      : null;
  if (input.method === 'item/started' || input.method === 'item/completed') {
    const item = record(params.item);
    if (item?.type !== 'collabToolCall') return null;
    const action =
      typeof item.tool === 'string' &&
      ['spawn_agent', 'send_input', 'resume_agent', 'wait', 'close_agent'].includes(item.tool)
        ? item.tool
        : undefined;
    const child = id(item.receiverThreadId) ?? id(item.newThreadId);
    const itemStatus =
      typeof item.status === 'string' && item.status.length <= 64 ? item.status : undefined;
    return {
      sessionId,
      occurredAt,
      kind: 'collaboration',
      ...(child ? { childId: child, childThreadId: child } : {}),
      ...(id(item.senderThreadId) ? { threadId: id(item.senderThreadId) } : {}),
      ...(typeof item.agentStatus === 'string' && item.agentStatus.length <= 64
        ? { childStatus: item.agentStatus }
        : itemStatus
          ? { childStatus: itemStatus }
          : {}),
      ...(action ? { collaborationAction: action } : {}),
    };
  }
  return null;
}
