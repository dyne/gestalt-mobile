/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { createSelfDebugSession, type CreateDebugDependencies } from './create-session.js';
import { RelaySession, type RelaySessionSnapshot } from '../sessions/model/relay-session.js';
import type { DebugContext } from '../../../shared/contracts/self-debug.js';

const now = '2026-10-06T12:00:00.000Z';
const context: DebugContext = {
  handoffTrace: 'handoff-1',
  control: 'control-1',
  mobileSession: 'source',
  codexThread: 'source-thread',
  capturedAt: now,
  versions: [{ id: 'gestalt', label: 'Gestalt', version: '2.13.1' }],
};

function fixture() {
  const order: string[] = [];
  let saved: RelaySessionSnapshot | null = null;
  const agent = {
    name: 'org-plan-executor' as const,
    model: 'configured-model',
    reasoningEffort: 'high' as const,
  };
  const startTurn = vi.fn(
    async (session: RelaySessionSnapshot) =>
      RelaySession.rehydrate(session).startTurn('debug-turn', now).snapshot,
  );
  const deps: CreateDebugDependencies = {
    createId: () => 'debug',
    now: () => now,
    settings: async () => agent,
    capture: async () => {
      order.push('capture');
      return {
        root: '/debug',
        absoluteTracePath: '/debug/traces/debug.json',
        debug: { context, tracePath: 'traces/debug.json', agent },
      };
    },
    askSource: vi.fn(async () => {
      order.push('ask-source');
      throw new Error('source unavailable');
    }),
    createSession: async (id, root, settings) => {
      order.push('create-root');
      return RelaySession.create({
        id,
        workspacePath: root,
        workspaceId: 'debug-workspace',
        provider: 'codex',
        profile: 'default',
        model: settings.model,
        effectiveSkillSelection: { skills: [] },
        now,
      }).snapshot;
    },
    start: async (session) =>
      RelaySession.rehydrate(session).bindThread('independent-thread', now).snapshot,
    startTurn,
    find: () => saved,
    save: (session) => {
      saved = session;
    },
    onStarted: vi.fn(),
  };
  return { deps, order, startTurn, saved: () => saved };
}

describe('Self DEBUG creation', () => {
  it('captures first and starts an independent root using configured executor settings despite source failure', async () => {
    const { deps, order, startTurn } = fixture();
    const result = await createSelfDebugSession(context, deps);
    expect(order).toEqual(['capture', 'ask-source', 'create-root']);
    expect(result).toMatchObject({
      id: 'debug',
      threadId: 'independent-thread',
      model: 'configured-model',
      state: 'turnActive',
      selfDebug: { context, agent: { reasoningEffort: 'high' } },
    });
    expect(startTurn.mock.calls[0]?.[0].selfDebug?.context).toEqual(context);
    expect(vi.mocked(deps.startTurn).mock.calls[0]?.[1]).toContain(
      'Redacted diagnostic trace: /debug/traces/debug.json',
    );
    expect(vi.mocked(deps.startTurn).mock.calls[0]?.[1]).toContain('root agent');
    expect(vi.mocked(deps.startTurn).mock.calls[0]?.[1]).toContain(
      'Do not publish either before the user confirms',
    );
    expect(deps.onStarted).toHaveBeenCalledOnce();
  });

  it('retains identifiers, trace, and a recoverable state when the new runtime fails', async () => {
    const { deps, saved } = fixture();
    deps.startTurn = vi.fn(async () => {
      throw new Error('runtime unavailable');
    });
    await expect(createSelfDebugSession(context, deps)).rejects.toThrow('runtime unavailable');
    expect(saved()).toMatchObject({
      id: 'debug',
      state: 'attentionRequired',
      threadId: 'independent-thread',
      selfDebug: { context, tracePath: 'traces/debug.json' },
    });
  });
});
