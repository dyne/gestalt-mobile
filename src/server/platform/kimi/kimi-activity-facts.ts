/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivityFact } from '../../features/agent-activity/model.js';
import type { KimiWsEvent } from './kimi-ws-client.js';
import type { KimiEventContext } from './kimi-normalizer.js';

/**
 * Decodes bounded activity evidence from kimi web events. Turn lifecycle is
 * prompt-based; `agent.status.updated` supplies context usage and
 * awaiting-human transitions (kimi 2.0.2 has no dedicated interaction events —
 * pending approvals/questions arrive through status changes plus REST lists).
 */
export function decodeKimiActivityFacts(
  sessionId: string,
  occurredAt: string,
  event: KimiWsEvent,
  context: KimiEventContext,
): readonly AgentActivityFact[] {
  const payload = record(event.payload);
  if (!payload || typeof payload.type !== 'string') return [];
  switch (payload.type) {
    case 'turn.started': {
      const agentId = safeId(payload.agentId);
      const turnNumber = safeTurn(payload.turnId);
      if (!agentId || turnNumber === null) return [];
      const turnId = context.resolveTurnId(agentId, turnNumber);
      return [
        {
          sessionId,
          occurredAt,
          kind: 'turnStarted',
          ...(event.session_id ? { threadId: event.session_id } : {}),
          ...(turnId ? { turnId } : {}),
          ...(context.isChildAgent(agentId) ? { childThreadId: agentId } : {}),
        },
      ];
    }
    case 'prompt.completed':
    case 'prompt.aborted': {
      const agentId = safeId(payload.agentId);
      const promptId = safeId(payload.promptId);
      if (!agentId || !promptId || context.isChildAgent(agentId)) return [];
      return [
        {
          sessionId,
          occurredAt,
          kind: 'turnCompleted',
          ...(event.session_id ? { threadId: event.session_id } : {}),
          turnId: promptId,
        },
      ];
    }
    case 'agent.status.updated': {
      const status = typeof payload.status === 'string' ? payload.status : null;
      const facts: AgentActivityFact[] = [];
      const usage = typeof payload.contextUsage === 'number' ? payload.contextUsage : null;
      if (usage !== null && usage >= 0) {
        facts.push({
          sessionId,
          occurredAt,
          kind: 'contextUsage',
          ...(event.session_id ? { threadId: event.session_id } : {}),
          contextUsedPercent:
            usage <= 1 ? Math.round(usage * 100) : Math.min(100, Math.round(usage)),
        });
      }
      if (status === 'awaiting_approval' || status === 'awaiting_question') {
        facts.push({
          sessionId,
          occurredAt,
          kind: 'interactionPending',
          ...(event.session_id ? { threadId: event.session_id } : {}),
          attentionReason:
            status === 'awaiting_approval' ? 'permissionRequired' : 'materialAmbiguity',
        });
      }
      return facts;
    }
    default:
      return [];
  }
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
