/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerSelfDebug } from './endpoint.js';
import { RelaySession } from '../sessions/model/relay-session.js';
import type { DebugContext, DebugProblem } from '../../../shared/contracts/self-debug.js';

const now = '2026-10-06T12:00:00.000Z';
const source = RelaySession.create({
  id: 'source',
  workspaceId: 'w',
  workspacePath: '/w',
  provider: 'codex',
  profile: 'default',
  effectiveSkillSelection: { skills: [] },
  now,
}).bindThread('root-thread', now).snapshot;
const context: DebugContext = {
  handoffTrace: 'handoff-1',
  control: 'control-1',
  mobileSession: source.id,
  codexThread: source.threadId!,
  versions: [{ id: 'codex', label: 'Codex', version: '0.160.0' }],
  capturedAt: now,
};

function fixture() {
  const app = fastify();
  let current = source;
  let time = now;
  const debug = {
    ...source,
    id: 'debug-root',
    threadId: 'independent-root',
    selfDebug: {
      context,
      tracePath: 'traces/debug-root.json',
      agent: { name: 'org-plan-executor' as const, model: 'configured-model' },
    },
  };
  const create = vi.fn(async () => debug);
  const readTrace = vi.fn(async () => '{"schemaVersion":1}');
  let blocker: DebugProblem | null = {
    requestId: 'attention-1',
    turnId: 'blocked-turn',
    requestedAt: now,
    attention: {
      reason: 'externalState',
      resumeCondition: 'externalStateChanged',
      summary: 'Installed capability guard failed.',
      requestedAction: 'Reconcile compatible tooling.',
    },
    supervisorReport: 'Explicit single support was overridden by the ambient capability.',
  };
  registerSelfDebug(app, {
    find: (id) => (id === source.id ? current : id === debug.id ? debug : null),
    context: () => context,
    createId: () => 'confirmation',
    now: () => time,
    create,
    readTrace,
    problem: (sessionId, requestId) =>
      sessionId === source.id && blocker?.requestId === requestId ? blocker : null,
  });
  return {
    app,
    create,
    readTrace,
    changeBlocker: (value: DebugProblem | null) => {
      blocker = value;
    },
    change: (session: typeof source) => {
      current = session;
    },
    expire: () => {
      time = '2026-10-06T13:00:00.000Z';
    },
  };
}

describe('Self DEBUG HTTP contract', () => {
  it('binds the selected server-side blocker snapshot to confirmation without trusting posted prose', async () => {
    const { app, create, changeBlocker } = fixture();
    try {
      const response = await app.inject(
        '/api/sessions/source/debug?attentionRequestId=attention-1',
      );
      expect(response.statusCode).toBe(200);
      const confirmation = response.json();
      expect(confirmation.problem.supervisorReport).toContain('Explicit single support');
      expect(confirmation.context).not.toHaveProperty('problem');
      changeBlocker(null);
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions/source/debug',
        payload: { confirmationId: confirmation.confirmationId },
      });
      expect(created.statusCode).toBe(202);
      expect(create).toHaveBeenCalledWith(context, confirmation.problem);
    } finally {
      await app.close();
    }
  });

  it('rejects stale, cross-session and client-authored blocker context', async () => {
    const { app, create } = fixture();
    try {
      expect(
        (await app.inject('/api/sessions/source/debug?attentionRequestId=other')).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject(
            '/api/sessions/source/debug?attentionRequestId=attention-1&report=forged',
          )
        ).statusCode,
      ).toBe(400);
      await app.inject('/api/sessions/source/debug?attentionRequestId=attention-1');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/sessions/other/debug',
            payload: { confirmationId: 'confirmation' },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/sessions/source/debug',
            payload: { confirmationId: 'confirmation', problem: { supervisorReport: 'forged' } },
          })
        ).statusCode,
      ).toBe(409);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('captures context only for an existing thread and creates exactly one independent session on repeated confirmation', async () => {
    const { app, create } = fixture();
    try {
      const confirmation = await app.inject('/api/sessions/source/debug');
      expect(confirmation.json()).toEqual({ confirmationId: 'confirmation', context });
      expect(create).not.toHaveBeenCalled();
      const responses = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: 'POST',
            url: '/api/sessions/source/debug',
            payload: { confirmationId: 'confirmation' },
          }),
        ),
      );
      expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(context);
      expect(responses[0]!.json().threadId).toBe('independent-root');
    } finally {
      await app.close();
    }
  });

  it('rejects missing and draft sessions and unconfirmed or altered requests', async () => {
    const { app, create, change } = fixture();
    try {
      expect((await app.inject('/api/sessions/missing/debug')).statusCode).toBe(404);
      change({ ...source, threadId: null, state: 'starting' });
      expect((await app.inject('/api/sessions/source/debug')).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/sessions/source/debug',
            payload: { confirmationId: 'forged', tracePath: '/secret' },
          })
        ).statusCode,
      ).toBe(409);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(['expired', 'replaced'] as const)('rejects a %s source confirmation', async (mode) => {
    const { app, create, change, expire } = fixture();
    try {
      await app.inject('/api/sessions/source/debug');
      if (mode === 'expired') expire();
      else change({ ...source, threadId: 'replacement' });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/sessions/source/debug',
            payload: { confirmationId: 'confirmation' },
          })
        ).statusCode,
      ).toBe(409);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not duplicate partial sessions after a failed launch and returns a safe problem', async () => {
    const { app, create } = fixture();
    create.mockRejectedValue(new Error('secret launch failure'));
    try {
      await app.inject('/api/sessions/source/debug');
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/sessions/source/debug',
          payload: { confirmationId: 'confirmation' },
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain('secret');
      }
      expect(create).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('serves only the trace retained by a Self DEBUG session', async () => {
    const { app, readTrace } = fixture();
    try {
      expect((await app.inject('/api/sessions/source/debug/trace')).statusCode).toBe(404);
      const response = await app.inject('/api/sessions/debug-root/debug/trace');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ schemaVersion: 1 });
      expect(readTrace).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
