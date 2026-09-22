/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionEvent } from '../../../shared/contracts/session-event.js';
import type { KimiWsEvent } from './kimi-ws-client.js';

/** Per-session context the runtime supplies while translating a kimi event stream. */
export type KimiEventContext = Readonly<{
  workspacePath?: string;
  activeTurnId?: string | null;
  /** Maps a kimi per-agent turn number to the gestalt prompt turn id. */
  resolveTurnId(agentId: string, turnNumber: number): string | null;
  /** True once an agent id is known to belong to a spawned subagent. */
  isChildAgent(agentId: string): boolean;
}>;

/**
 * Maps kimi web session events onto the relay's provider-neutral event types.
 * The relay's turn lifecycle is prompt-based (`prompt.completed`/`aborted`),
 * because a gestalt turn id is the kimi prompt id; `turn.started` exists only
 * to bind kimi per-agent turn numbers to prompt ids. Unknown future event
 * types deliberately become `null`, mirroring the codex normalizer.
 */
export function normalizeKimiEvent(
  sessionId: string,
  sequence: number,
  occurredAt: string,
  event: KimiWsEvent,
  context: KimiEventContext = {
    resolveTurnId: () => null,
    isChildAgent: () => false,
  },
): SessionEvent | null {
  const payload = record(event.payload);
  if (!payload || typeof payload.type !== 'string') return null;
  switch (payload.type) {
    case 'assistant.delta': {
      const agentId = safeId(payload.agentId);
      const turnNumber = safeTurn(payload.turnId);
      const delta = bounded(payload.delta, 64_000);
      if (!agentId || turnNumber === null || delta === null) return null;
      if (context.isChildAgent(agentId)) return null;
      const turnId = context.resolveTurnId(agentId, turnNumber) ?? `kimi:${agentId}:${turnNumber}`;
      return {
        sessionId,
        sequence,
        occurredAt,
        type: 'agentMessageDelta',
        payload: { text: delta, itemId: `kimi:${agentId}:${turnNumber}`, turnId },
      };
    }
    case 'tool.call.started': {
      const toolCallId = safeId(payload.toolCallId);
      const agentId = safeId(payload.agentId) ?? 'main';
      const turnNumber = safeTurn(payload.turnId);
      if (!toolCallId || turnNumber === null) return null;
      const display = record(payload.display);
      const kind = typeof display?.kind === 'string' ? display.kind : 'generic';
      const name = safeId(payload.name);
      const description = bounded(payload.description, 500);
      const detail =
        (typeof display?.command === 'string' ? bounded(display.command, 500) : null) ??
        (typeof display?.path === 'string' ? bounded(display.path, 500) : null) ??
        description ??
        name ??
        kind;
      const label =
        kind === 'command' || kind === 'bash'
          ? 'Command'
          : kind === 'file_io'
            ? 'File'
            : `Tool · ${name ?? kind}`;
      const owner = ownership(agentId, turnNumber, context);
      return {
        sessionId,
        sequence,
        occurredAt,
        type: 'activity.updated',
        payload: { id: toolCallId, label, detail, ...owner },
      };
    }
    case 'tool.result': {
      const toolCallId = safeId(payload.toolCallId);
      const agentId = safeId(payload.agentId) ?? 'main';
      const turnNumber = safeTurn(payload.turnId);
      if (!toolCallId || turnNumber === null) return null;
      const isError = payload.isError === true;
      const owner = ownership(agentId, turnNumber, context);
      return {
        sessionId,
        sequence,
        occurredAt,
        type: 'activity.updated',
        payload: {
          id: toolCallId,
          label: isError ? 'Tool error' : 'Tool result',
          detail: bounded(safeJson(payload.output), 400) ?? (isError ? 'failed' : 'done'),
          ...owner,
        },
      };
    }
    case 'subagent.spawned': {
      const subagentId = safeId(payload.subagentId);
      if (!subagentId) return null;
      const name = bounded(payload.subagentName, 128);
      const description = bounded(payload.description, 300);
      return {
        sessionId,
        sequence,
        occurredAt,
        type: 'activity.updated',
        payload: {
          id: subagentId,
          label: 'Subagent',
          detail: [name, description].filter(Boolean).join(' · '),
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        },
      };
    }
    case 'subagent.completed':
    case 'subagent.failed': {
      const subagentId = safeId(payload.subagentId);
      if (!subagentId) return null;
      const failed = payload.type === 'subagent.failed';
      return {
        sessionId,
        sequence,
        occurredAt,
        type: 'activity.updated',
        payload: {
          id: subagentId,
          label: failed ? 'Subagent failed' : 'Subagent completed',
          detail: bounded(payload.resultSummary, 500) ?? '',
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        },
      };
    }
    case 'prompt.completed': {
      const agentId = safeId(payload.agentId);
      const promptId = safeId(payload.promptId);
      if (!agentId || !promptId || context.isChildAgent(agentId)) return null;
      return {
        sessionId,
        sequence,
        occurredAt,
        type: 'turnCompleted',
        payload: {
          turn: {
            id: promptId,
            ...(typeof payload.reason === 'string' ? { status: bounded(payload.reason, 64) } : {}),
          },
        },
      };
    }
    case 'prompt.aborted': {
      const agentId = safeId(payload.agentId);
      const promptId = safeId(payload.promptId);
      if (!agentId || !promptId || context.isChildAgent(agentId)) return null;
      return {
        sessionId,
        sequence,
        occurredAt,
        type: 'turnInterrupted',
        payload: { turn: { id: promptId } },
      };
    }
    default:
      return null;
  }
}

function ownership(
  agentId: string,
  turnNumber: number,
  context: KimiEventContext,
): Record<string, string> {
  if (context.isChildAgent(agentId)) {
    return {
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      actorTurnId: `${agentId}:${turnNumber}`,
    };
  }
  const turnId = context.resolveTurnId(agentId, turnNumber);
  return turnId ? { turnId } : context.activeTurnId ? { turnId: context.activeTurnId } : {};
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function safeTurn(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function safeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.slice(0, 400);
  try {
    return JSON.stringify(value).slice(0, 400);
  } catch {
    return null;
  }
}
