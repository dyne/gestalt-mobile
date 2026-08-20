/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type {
  AutopilotAuditRecord,
  ChatSnapshot,
  SafeInteractionSnapshot,
} from '../../../../shared/contracts/chat-snapshot.js';
import type { SessionEvent } from '../../../../shared/contracts/session-event.js';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { toChatItems, toChatTurns, type ChatItem, type HistoryTurn } from './history-mapper.js';

/**
 * ChatSnapshot is a lower-bound cut: baseSequence is sampled before the
 * upstream read, therefore every event with a higher sequence remains eligible
 * for ordered replay even when its effect is already visible in the snapshot.
 */

export function registerGetHistory(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    read(session: RelaySessionSnapshot): Promise<{
      turns: HistoryTurn[];
      activeTurnId: string | null;
    }>;
    currentSequence(sessionId: string): number;
    interactions?(sessionId: string): SafeInteractionSnapshot[];
    autopilotControlTurns?(sessionId: string): ReadonlyMap<string, string>;
    /** Bounded, redacted audit source; this endpoint never materializes a journal. */
    autopilotAudit?(
      sessionId: string,
      limit: number,
    ): readonly SessionEvent[] | { events: readonly SessionEvent[]; truncated: boolean };
  },
): void {
  app.get('/api/sessions/:id/history', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const baseSequence = deps.currentSequence(session.id);
    let history: Awaited<ReturnType<typeof deps.read>>;
    try {
      history = await deps.read(session);
    } catch (error) {
      if (error instanceof Error && error.message === 'CODEX_SESSION_NOT_RUNNING')
        return reply.code(409).type('application/problem+json').send({
          type: 'urn:gestalt-mobile:error:session-history-unavailable',
          title: 'Session history unavailable',
          status: 409,
          detail:
            'GET /api/sessions/:id/history requires an active Codex session process. Open the session to restore it, then retry.',
          code: 'SESSION_HISTORY_UNAVAILABLE',
          retryable: true,
        });
      return reply.code(502).type('application/problem+json').send({
        type: 'urn:gestalt-mobile:error:session-history-read-failed',
        title: 'Session history read failed',
        status: 502,
        detail:
          'GET /api/sessions/:id/history reached the relay, but Codex could not read this session history. The Codex process may have stopped during recovery; open the session again and inspect the running relay output if it persists.',
        code: 'SESSION_HISTORY_READ_FAILED',
        retryable: true,
      });
    }
    const controls = deps.autopilotControlTurns?.(session.id) ?? new Map<string, string>();
    const items: ChatItem[] = toChatItems(history.turns, controls);
    const auditSource = deps.autopilotAudit?.(session.id, 100) ?? [];
    const boundedAudit = isBoundedAudit(auditSource) ? auditSource : null;
    const auditEvents: readonly SessionEvent[] = boundedAudit
      ? boundedAudit.events
      : (auditSource as readonly SessionEvent[]);
    const autopilotAudit = toAutopilotAudit(auditEvents);
    const snapshot: ChatSnapshot = {
      items,
      turns: toChatTurns(history.turns, controls),
      activeTurnId: history.activeTurnId,
      interactions: deps.interactions?.(session.id) ?? [],
      ...(autopilotAudit.length ? { autopilotAudit } : {}),
      ...(boundedAudit?.truncated ? { autopilotAuditTruncated: true } : {}),
      baseSequence,
      // Temporary compatibility for clients which have not adopted ChatSnapshot.
      currentSequence: baseSequence,
    };
    return reply.send(snapshot);
  });
}

function isBoundedAudit(
  source: readonly SessionEvent[] | { events: readonly SessionEvent[]; truncated: boolean },
): source is { events: readonly SessionEvent[]; truncated: boolean } {
  return !Array.isArray(source) && 'events' in source;
}

const auditLabels: Readonly<Record<string, string>> = {
  'autopilot.continuation-scheduled': 'Autopilot scheduled a continuation',
  'autopilot.control-issued': 'Autopilot issued an automatic continuation.',
  'autopilot.turn-started': 'Autopilot continuation started',
  'autopilot.turn-failed': 'Autopilot continuation failed',
  'autopilot.progress-reset': 'Autopilot reset retry progress after the plan changed',
  'org-plan.attention-required': 'Autopilot needs attention',
  'org-plan.attention-resolved': 'Attention resolved',
};

function snapshotAuditLabel(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const { state, reason } = payload as { state?: unknown; reason?: unknown };
  if (state === 'backoff') return 'Autopilot is backing off';
  if (state === 'attentionRequired') return 'Autopilot needs attention';
  if (state === 'completed') return 'Autopilot completed the plan';
  if (state === 'disabled' && reason === 'planRequired')
    return 'Autopilot requires an incomplete supervised plan';
  return null;
}

/** Maps journal vocabulary to a deliberately redacted, durable timeline projection. */
function toAutopilotAudit(events: readonly SessionEvent[]): AutopilotAuditRecord[] {
  return events.flatMap((event) => {
    const occurredAt = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredAt)) return [];
    const label =
      event.type === 'org-plan.attention-resolved' &&
      event.payload &&
      typeof event.payload === 'object' &&
      (event.payload as { outcome?: unknown }).outcome === 'failed'
        ? 'Attention resolution failed'
        : (auditLabels[event.type] ??
          (event.type === 'autopilot.updated' ? snapshotAuditLabel(event.payload) : null));
    if (!label) return [];
    const controlId =
      event.payload &&
      typeof event.payload === 'object' &&
      typeof (event.payload as { controlId?: unknown }).controlId === 'string'
        ? (event.payload as { controlId: string }).controlId
        : undefined;
    return [
      { id: `audit:${event.sequence}`, label, occurredAt, ...(controlId ? { controlId } : {}) },
    ];
  });
}
