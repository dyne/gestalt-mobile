/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGetHistory } from './endpoint.js';

describe('GET /api/sessions/:id/history', () => {
  it('reads a stopped persisted session through the supplied detached reader', async () => {
    const app = fastify();
    const read = vi.fn(async () => ({ turns: [], activeTurnId: null }));
    registerGetHistory(app, {
      find: () => ({ id: 's', threadId: 'thread-1', state: 'stopped' }) as never,
      read,
      currentSequence: () => 0,
    });
    expect((await app.inject('/api/sessions/s/history')).statusCode).toBe(200);
    expect(read).toHaveBeenCalledOnce();
    await app.close();
  });
  it('returns normalized canonical history', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      read: async () => ({
        turns: [
          {
            items: [{ id: 'a', type: 'agentMessage', text: 'hello', phase: 'final_answer' }],
            startedAt: 1_784_102_400,
            completedAt: 1_784_102_520,
          },
        ],
        activeTurnId: 'terminal-turn-1',
      }),
      currentSequence: () => 42,
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s/history' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: 'a',
          kind: 'agent',
          text: 'hello',
          phase: 'final_answer',
          turnId: 'history-turn-0',
          occurredAt: 1_784_102_520_000,
        },
      ],
      turns: [
        {
          id: 'history-turn-0',
          items: [
            {
              id: 'a',
              kind: 'agent',
              text: 'hello',
              phase: 'final_answer',
              turnId: 'history-turn-0',
              occurredAt: 1_784_102_520_000,
            },
          ],
          startedAt: 1_784_102_400,
          completedAt: 1_784_102_520,
        },
      ],
      activeTurnId: 'terminal-turn-1',
      interactions: [],
      baseSequence: 42,
      currentSequence: 42,
    });
    await app.close();
  });

  it('restores only redacted durable autopilot audit records from the journal', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      currentSequence: () => 9,
      read: async () => ({ turns: [], activeTurnId: null }),
      autopilotAudit: (_id, limit) => {
        expect(limit).toBe(100);
        return [
          {
            sessionId: 's',
            sequence: 4,
            type: 'autopilot.continuation-scheduled',
            occurredAt: '2026-08-20T00:00:00.000Z',
            payload: { controlId: 'control-1', prompt: 'secret prompt' },
          },
          {
            sessionId: 's',
            sequence: 5,
            type: 'autopilot.updated',
            occurredAt: '2026-08-20T00:00:01.000Z',
            payload: { state: 'completed', environment: 'secret' },
          },
          {
            sessionId: 's',
            sequence: 6,
            type: 'org-plan.attention-resolved',
            occurredAt: '2026-08-20T00:00:02.000Z',
            payload: { outcome: 'failed', stack: 'secret' },
          },
        ];
      },
    });
    const response = await app.inject('/api/sessions/s/history');
    expect(response.json().autopilotAudit).toEqual([
      {
        id: 'audit:4',
        label: 'Scheduled a continuation',
        occurredAt: Date.parse('2026-08-20T00:00:00.000Z'),
        controlId: 'control-1',
      },
      {
        id: 'audit:5',
        label: 'Completed the plan',
        occurredAt: Date.parse('2026-08-20T00:00:01.000Z'),
      },
      {
        id: 'audit:6',
        label: 'Attention resolution failed',
        occurredAt: Date.parse('2026-08-20T00:00:02.000Z'),
      },
    ]);
    expect(response.body).not.toContain('secret');
    await app.close();
  });

  it('marks a deliberately bounded audit tail as truncated without reading a journal body', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      currentSequence: () => 9,
      read: async () => ({ turns: [], activeTurnId: null }),
      autopilotAudit: (_id, limit) => {
        expect(limit).toBe(100);
        return {
          events: [
            {
              sessionId: 's',
              sequence: 9,
              type: 'autopilot.turn-failed',
              occurredAt: '2026-08-20T00:00:00.000Z',
              payload: { controlId: 'control-1', code: 'START_FAILED' },
            },
          ],
          truncated: true,
        };
      },
    });
    expect((await app.inject('/api/sessions/s/history')).json()).toMatchObject({
      autopilotAuditTruncated: true,
      autopilotAudit: [expect.objectContaining({ label: 'Continuation failed' })],
    });
    await app.close();
  });

  it('takes the replay lower bound before the upstream history read', async () => {
    const app = fastify();
    let sequence = 7;
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      currentSequence: () => sequence,
      read: async () => {
        entered();
        await reading;
        return { turns: [], activeTurnId: null };
      },
    });
    const response = app.inject({ method: 'GET', url: '/api/sessions/s/history' });
    await readStarted;
    sequence = 8; // completion/event after read starts remains replayable (> baseSequence).
    release();
    expect((await response).json()).toMatchObject({ baseSequence: 7, currentSequence: 7 });
    await app.close();
  });

  it('returns pending then resolved safe interactions without answer content', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      currentSequence: () => 3,
      read: async () => ({ turns: [], activeTurnId: null }),
      interactions: () => [
        {
          requestId: 'pending',
          kind: 'quiz',
          turnId: 'turn-1',
          requestedAt: 't',
          resolvedAt: null,
          payload: { question: 'safe prompt' },
        },
        {
          requestId: 'resolved',
          kind: 'quiz',
          turnId: 'turn-1',
          requestedAt: 't',
          resolvedAt: 'u',
          outcome: 'answered',
        },
      ],
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s/history' });
    expect(response.json().interactions).toEqual([
      {
        requestId: 'pending',
        kind: 'quiz',
        turnId: 'turn-1',
        requestedAt: 't',
        resolvedAt: null,
        payload: { question: 'safe prompt' },
      },
      {
        requestId: 'resolved',
        kind: 'quiz',
        turnId: 'turn-1',
        requestedAt: 't',
        resolvedAt: 'u',
        outcome: 'answered',
      },
    ]);
    expect(response.body).not.toContain('secret-native-answer');
    await app.close();
  });

  it('recovers a pruned journal from a complete snapshot while higher events remain replayable', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      currentSequence: () => 40,
      read: async () => ({
        turns: [
          {
            id: 'turn-1',
            items: [{ id: 'final', type: 'agentMessage', text: 'final', phase: 'final_answer' }],
            startedAt: 1,
            completedAt: 2,
          },
        ],
        activeTurnId: null,
      }),
      interactions: () => [
        {
          requestId: 'pending',
          kind: 'userInput',
          turnId: 'turn-1',
          requestedAt: 't',
          resolvedAt: null,
          payload: {},
        },
        {
          requestId: 'resolved',
          kind: 'quiz',
          turnId: 'turn-1',
          requestedAt: 't',
          resolvedAt: 'u',
          outcome: 'answered',
        },
      ],
    });
    const snapshot = (await app.inject({ method: 'GET', url: '/api/sessions/s/history' })).json();
    expect(snapshot).toMatchObject({
      baseSequence: 40,
      activeTurnId: null,
      turns: [{ id: 'turn-1', items: [{ id: 'final', text: 'final' }] }],
      interactions: [
        { requestId: 'pending', resolvedAt: null },
        { requestId: 'resolved', outcome: 'answered' },
      ],
    });
    const replayable = [
      {
        sequence: 41,
        type: 'interaction.resolved',
        payload: { requestId: 'resolved', turnId: 'turn-1', resolvedAt: 'u', outcome: 'answered' },
      },
    ];
    expect(replayable.filter((event) => event.sequence > snapshot.baseSequence)).toHaveLength(1);
    expect(JSON.stringify(replayable)).not.toContain('secret-native-answer');
    await app.close();
  });

  it('reports a recoverable diagnostic when the Codex process is absent', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      read: async () => {
        throw new Error('CODEX_SESSION_NOT_RUNNING');
      },
      currentSequence: () => 0,
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s/history' });
    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      code: 'SESSION_HISTORY_UNAVAILABLE',
      retryable: true,
      detail: expect.stringContaining('GET /api/sessions/:id/history'),
    });
    await app.close();
  });

  it('reports a Codex history-read failure without leaking its raw error', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      read: async () => {
        throw new Error('upstream detail that must not reach the browser');
      },
      currentSequence: () => 0,
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s/history' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: 'SESSION_HISTORY_READ_FAILED',
      retryable: true,
      detail: expect.stringContaining('GET /api/sessions/:id/history'),
    });
    expect(response.body).not.toContain('upstream detail');
    await app.close();
  });
});
