/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { toOrgPlanAttentionToolResponse } from '../../../../shared/contracts/org-plan-attention.js';
import { AttentionResolution, type AttentionResolutionPorts } from './resolve.js';

function fixture(acknowledged = false) {
  const effects: string[] = [];
  const saved = new Map<string, { body: string }>();
  const ports: AttentionResolutionPorts = {
    operations: {
      find: () => ({
        requestId: 'request',
        kind: 'orgPlanAttention',
        payload: {
          reason: 'hardBlock',
          resumeCondition: 'externalStateChanged',
          summary: 'Repair required.',
          requestedAction: 'Repair it.',
        },
      }),
      terminalOperation: () => null,
      claimOperation: () => 'claimed',
      resolved: () => null,
      resolutionState: () => (acknowledged ? 'acknowledged' : 'active'),
      beginDelivery: () => true,
      retryDelivery: (_id, _request, _key, state = 'active') => {
        effects.push(`retry:${state}`);
        return true;
      },
      settleOperation: (_id, _request, _key, _at, outcome) => {
        effects.push(`settle:${outcome}`);
        return true;
      },
    },
    replay: {
      find: (scope, key) => saved.get(`${scope}:${key}`) ?? null,
      remember: (scope, key, body) => {
        effects.push('remember');
        saved.set(`${scope}:${key}`, { body });
      },
    },
    writer: {
      available: () => true,
      capable: () => true,
      state: () => 'available',
      resolve: () => {
        effects.push('reply');
        return true;
      },
      guidance: () => async () => {
        effects.push('guidance');
      },
    },
    policy: {
      authorizeReplacement: () => true,
      enable: () => {
        effects.push('enable');
      },
      disable: () => {
        effects.push('disable');
      },
    },
    publishSettlement: (_id, _request, _at, outcome) => {
      effects.push(`publish:${outcome}`);
    },
    now: () => '2026-11-01T17:00:00.000Z',
  };
  const input = {
    sessionId: 'session',
    requestId: 'request',
    operationKey: 'operation',
    response: toOrgPlanAttentionToolResponse({ action: 'resume' }),
  };
  return { ports, effects, saved, input, resolver: new AttentionResolution(ports) };
}

describe('attention resolution', () => {
  it('delivers before durable settlement and publishes only after replay is durable', async () => {
    const f = fixture();
    const accepted = await f.resolver.resolve(f.input);
    expect(accepted).toEqual({ kind: 'accepted', resolvedAt: f.ports.now() });
    expect(f.effects).toEqual([
      'reply',
      'settle:answered',
      'remember',
      'publish:answered',
      'enable',
    ]);
    expect(await f.resolver.resolve(f.input)).toEqual({
      kind: 'replayed',
      resolvedAt: f.ports.now(),
    });
    expect(f.effects).toHaveLength(5);
  });

  it('can disable acknowledged attention offline without acquiring or replying to a writer', async () => {
    const f = fixture(true);
    f.ports.writer.available = () => false;
    f.ports.writer.guidance = () => {
      throw new Error('offline guidance must not be acquired');
    };
    f.input.response = toOrgPlanAttentionToolResponse({ action: 'disableAutopilot' });
    expect(await f.resolver.resolve(f.input)).toMatchObject({ kind: 'accepted' });
    expect(f.effects).toEqual(['settle:answered', 'remember', 'publish:answered', 'disable']);
  });

  it('keeps an unavailable unacknowledged writer retryable without publishing settlement', async () => {
    const f = fixture();
    f.ports.writer.state = () => 'unavailable';
    expect(await f.resolver.resolve(f.input)).toEqual({ kind: 'writerUnavailable' });
    expect(f.effects).toEqual(['retry:active']);
    f.ports.writer.state = () => 'available';
    expect(await f.resolver.resolve(f.input)).toMatchObject({ kind: 'accepted' });
  });

  it('settles a cleared writer as failed without enabling automation or saving success replay', async () => {
    const f = fixture();
    f.ports.writer.state = () => 'cleared';
    expect(await f.resolver.resolve(f.input)).toEqual({
      kind: 'writerCleared',
      resolvedAt: f.ports.now(),
    });
    expect(f.effects).toEqual(['settle:failed', 'publish:failed']);
    expect(f.saved.size).toBe(0);
  });

  it('coalesces held guidance and releases the operation for a retry after failure', async () => {
    const f = fixture(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    f.ports.writer.guidance = () => async () => {
      entered = true;
      f.effects.push('guidance');
      await gate;
      throw new Error('writer unavailable');
    };
    f.input.response = toOrgPlanAttentionToolResponse({ action: 'resume', guidance: 'Continue.' });
    const attempts: Array<ReturnType<typeof f.resolver.resolve>> = [];
    try {
      attempts.push(f.resolver.resolve(f.input));
      await vi.waitFor(() => expect(entered).toBe(true));
      attempts.push(f.resolver.resolve(f.input));
      release();
      expect(await Promise.all(attempts)).toEqual([
        { kind: 'writerUnavailable' },
        { kind: 'writerUnavailable' },
      ]);
      expect(f.effects).toEqual(['guidance', 'retry:acknowledged']);
      f.ports.writer.guidance = () => async () => {
        f.effects.push('retry-guidance');
      };
      expect(await f.resolver.resolve(f.input)).toMatchObject({ kind: 'accepted' });
      expect(f.effects.at(-1)).toBe('enable');
    } finally {
      release();
      await Promise.allSettled(attempts);
    }
  });
});
