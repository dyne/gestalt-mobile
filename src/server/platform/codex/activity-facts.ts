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

/** Decodes only bounded app-server evidence; unsupported shapes deliberately become no facts. */
export function decodeAgentActivityFacts(
  sessionId: string,
  occurredAt: string,
  input: { method?: string; params?: unknown },
): readonly AgentActivityFact[] {
  const params = record(input.params);
  if (!params) return [];
  if (input.method === 'thread/started') {
    const thread = record(params.thread);
    const status = record(thread?.status);
    return id(thread?.id)
      ? [
          {
            sessionId,
            occurredAt,
            kind: 'threadStarted',
            threadId: id(thread?.id),
            ...(typeof status?.type === 'string' ? { status: status.type } : {}),
          },
        ]
      : [];
  }
  if (input.method === 'thread/status/changed') {
    const status = record(params.status);
    return id(params.threadId) && typeof status?.type === 'string' && status.type.length <= 64
      ? [
          {
            sessionId,
            occurredAt,
            kind: 'threadStatus',
            threadId: id(params.threadId),
            status: status.type,
          },
        ]
      : [];
  }
  if (input.method === 'turn/started')
    return id(params.threadId)
      ? [
          {
            sessionId,
            occurredAt,
            kind: 'turnStarted',
            threadId: id(params.threadId),
            turnId: id(record(params.turn)?.id),
          },
        ]
      : [];
  if (input.method === 'turn/completed')
    return id(record(params.turn)?.id)
      ? [
          {
            sessionId,
            occurredAt,
            kind: 'turnCompleted',
            threadId: id(params.threadId),
            turnId: id(record(params.turn)?.id),
            status:
              typeof record(params.turn)?.status === 'string'
                ? (record(params.turn)?.status as string)
                : undefined,
          },
        ]
      : [];
  if (input.method === 'item/started' || input.method === 'item/completed') {
    const item = record(params.item);
    if (item?.type !== 'collabAgentToolCall' && item?.type !== 'collabToolCall') return [];
    const action = typeof item.tool === 'string' ? collaborationAction(item.tool) : undefined;
    const agentsStates = record(item.agentsStates);
    const currentChildren = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.flatMap((candidate) => (id(candidate) ? [id(candidate)!] : []))
      : [];
    const legacyChild = id(item.receiverThreadId) ?? id(item.newThreadId);
    const stateChildren = agentsStates
      ? Object.keys(agentsStates).flatMap((key) => (id(key) ? [key] : []))
      : [];
    const children = [
      ...new Set([...currentChildren, ...stateChildren, ...(legacyChild ? [legacyChild] : [])]),
    ].slice(0, 64);
    const sender = id(item.senderThreadId);
    const fact = (child?: string): AgentActivityFact => {
      const agentState = child && agentsStates ? record(agentsStates[child]) : undefined;
      const currentStatus =
        typeof agentState?.status === 'string' && agentState.status.length <= 64
          ? agentState.status
          : undefined;
      const legacyStatus =
        typeof item.agentStatus === 'string' && item.agentStatus.length <= 64
          ? item.agentStatus
          : typeof item.status === 'string' && item.status.length <= 64
            ? item.status
            : undefined;
      const model =
        action === 'spawn_agent' && typeof item.model === 'string' && item.model.length <= 256
          ? item.model
          : undefined;
      return {
        sessionId,
        occurredAt,
        kind: 'collaboration',
        ...(child ? { childId: child, childThreadId: child } : {}),
        ...(sender ? { threadId: sender } : {}),
        ...((currentStatus ?? (item.type === 'collabToolCall' ? legacyStatus : undefined))
          ? { childStatus: currentStatus ?? legacyStatus }
          : {}),
        ...(action ? { collaborationAction: action } : {}),
        ...(model ? { childModel: model } : {}),
      };
    };
    return children.length > 0 ? children.map((child) => fact(child)) : [fact()];
  }
  return [];
}

/** Legacy single-fact adapter kept for narrow callers and compatibility tests. */
export function decodeAgentActivityFact(
  sessionId: string,
  occurredAt: string,
  input: { method?: string; params?: unknown },
): AgentActivityFact | null {
  return decodeAgentActivityFacts(sessionId, occurredAt, input)[0] ?? null;
}

function collaborationAction(tool: string): string | undefined {
  return (
    {
      spawnAgent: 'spawn_agent',
      sendInput: 'send_input',
      resumeAgent: 'resume_agent',
      closeAgent: 'close_agent',
      spawn_agent: 'spawn_agent',
      send_input: 'send_input',
      resume_agent: 'resume_agent',
      close_agent: 'close_agent',
      wait: 'wait',
    } as Record<string, string>
  )[tool];
}
