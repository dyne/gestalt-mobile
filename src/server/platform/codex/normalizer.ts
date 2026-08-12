/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionEvent } from '../../../shared/contracts/session-event.js';
import { relative } from 'node:path';

export function normalizeCodexNotification(
  sessionId: string,
  sequence: number,
  occurredAt: string,
  notification: { method?: string; params?: unknown },
  workspacePath?: string,
  activeTurnId?: string | null,
): SessionEvent | null {
  const decoded = decodeNotification(notification);
  if (!decoded) return null;
  if (decoded.method === 'item/agentMessage/delta')
    return {
      sessionId,
      sequence,
      occurredAt,
      type: 'agentMessageDelta',
      payload: {
        text: decoded.params.delta,
        ...(decoded.params.itemId ? { itemId: decoded.params.itemId } : {}),
        ...((decoded.params.turnId ?? activeTurnId)
          ? { turnId: decoded.params.turnId ?? activeTurnId }
          : {}),
      },
    };
  if (decoded.method === 'turn/completed')
    return {
      sessionId,
      sequence,
      occurredAt,
      type: 'turnCompleted',
      payload: decoded.params,
    };
  if (decoded.method === 'item/started' || decoded.method === 'item/completed') {
    const message = safeAgentMessage(decoded.params.item, activeTurnId);
    if (message)
      return {
        sessionId,
        sequence,
        occurredAt,
        type: decoded.method === 'item/started' ? 'agentMessageStarted' : 'agentMessageCompleted',
        payload: message,
      };
    const activity = safeActivity(decoded.params.item, workspacePath, activeTurnId);
    if (activity)
      return { sessionId, sequence, occurredAt, type: 'activity.updated', payload: activity };
  }
  return null;
}

type DecodedNotification =
  | {
      method: 'item/agentMessage/delta';
      params: { delta: string; itemId?: string; turnId?: string };
    }
  | {
      method: 'turn/completed';
      params: { threadId?: string; turn: { id: string; status?: string } };
    }
  | { method: 'item/started' | 'item/completed'; params: { item: unknown } };

/** Strictly decode only consumed notification shapes; unknown/future methods stay isolated. */
export function decodeNotification(input: {
  method?: string;
  params?: unknown;
}): DecodedNotification | null {
  if (input.method === 'item/agentMessage/delta') {
    const params = record(input.params);
    return typeof params?.delta === 'string' && params.delta.length <= 64_000
      ? {
          method: input.method,
          params: {
            delta: params.delta,
            ...(safeId(params.itemId) ? { itemId: params.itemId as string } : {}),
            ...(safeId(params.turnId) ? { turnId: params.turnId as string } : {}),
          },
        }
      : null;
  }
  if (input.method === 'turn/completed') {
    const params = record(input.params);
    const turn = record(params?.turn);
    if (!turn || typeof turn.id !== 'string' || turn.id.length > 256) return null;
    return {
      method: input.method,
      params: {
        ...(typeof params?.threadId === 'string' && params.threadId.length <= 256
          ? { threadId: params.threadId }
          : {}),
        turn: {
          id: turn.id,
          ...(typeof turn.status === 'string' && turn.status.length <= 64
            ? { status: turn.status }
            : {}),
        },
      },
    };
  }
  if (input.method === 'item/started' || input.method === 'item/completed') {
    const params = record(input.params);
    return params && 'item' in params
      ? { method: input.method, params: { item: params.item } }
      : null;
  }
  return null;
}

function safeActivity(
  item: unknown,
  workspacePath?: string,
  activeTurnId?: string | null,
): { id: string; label: string; detail: string; turnId?: string } | null {
  if (!item || typeof item !== 'object') return null;
  const value = item as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.type !== 'string') return null;
  const owner = safeId(value.turnId)
    ? { turnId: value.turnId as string }
    : activeTurnId
      ? { turnId: activeTurnId }
      : {};
  const status = typeof value.status === 'string' ? ` · ${value.status}` : '';
  if (value.type === 'commandExecution' && typeof value.command === 'string')
    return { id: value.id, label: `Command${status}`, detail: value.command, ...owner };
  if (value.type === 'plan' && typeof value.text === 'string')
    return { id: value.id, label: 'Plan', detail: value.text, ...owner };
  if (value.type === 'reasoning' && Array.isArray(value.summary)) {
    const detail = reasoningSummary(value.summary).join('\n');
    return detail ? { id: value.id, label: 'Reasoning summary', detail, ...owner } : null;
  }
  if (value.type === 'fileChange' && Array.isArray(value.changes))
    return {
      id: value.id,
      label: `File change${status}`,
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
      ...owner,
    };
  if (
    (value.type === 'mcpToolCall' || value.type === 'dynamicToolCall') &&
    typeof value.tool === 'string'
  )
    return { id: value.id, label: `Tool${status}`, detail: value.tool, ...owner };
  return null;
}

function safeAgentMessage(
  item: unknown,
  activeTurnId?: string | null,
): {
  itemId: string;
  text: string;
  phase?: 'commentary' | 'final_answer';
  turnId?: string;
} | null {
  const value = record(item);
  if (!value || value.type !== 'agentMessage' || !safeId(value.id)) return null;
  if (value.text !== undefined && typeof value.text !== 'string') return null;
  const phase = value.phase === 'commentary' || value.phase === 'final_answer' ? value.phase : null;
  return {
    itemId: value.id as string,
    text: typeof value.text === 'string' ? value.text : '',
    ...(phase ? { phase } : {}),
    ...(safeId(value.turnId)
      ? { turnId: value.turnId as string }
      : activeTurnId
        ? { turnId: activeTurnId }
        : {}),
  };
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
