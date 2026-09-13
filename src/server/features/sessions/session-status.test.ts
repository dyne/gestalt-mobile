/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { deriveSessionStatus } from './session-status.js';

const observedAt = '2026-09-13T12:00:00.000Z';
const base = {
  session: { state: 'ready' },
  plan: null,
  activity: null,
  autopilot: null,
  pendingAttention: false,
  observedAt,
} as const;

describe('deriveSessionStatus', () => {
  it.each([
    [{ ...base, pendingAttention: true }, 'idle', 'needsYou'],
    [{ ...base, session: { state: 'ready', activeTurnId: 'turn' } }, 'working', 'rootTurn'],
    [
      {
        ...base,
        activity: {
          confidence: 'fresh',
          root: { state: 'idle' },
          subagents: [{ state: 'working' }],
        },
      },
      'working',
      'agent',
    ],
    [
      {
        ...base,
        activity: {
          confidence: 'fresh',
          root: { state: 'idle' },
          subagents: [{ state: 'idle', ownedProcesses: [{ state: 'running' }] }],
        },
      },
      'working',
      'process',
    ],
    [
      {
        ...base,
        plan: { allDone: true },
        activity: { confidence: 'fresh', root: { state: 'idle' }, subagents: [] },
      },
      'idle',
      'complete',
    ],
    [
      {
        ...base,
        plan: { allDone: false },
        autopilot: { health: { healthy: true, nextExpectedAction: 'Wait for a wake.' } },
      },
      'working',
      'autopilot',
    ],
    [
      {
        ...base,
        plan: { allDone: false },
        autopilot: { health: { healthy: false, nextExpectedAction: 'Restore continuation.' } },
      },
      'idle',
      'incompleteWithoutContinuation',
    ],
    [{ ...base, session: { state: 'stopped' } }, 'idle', 'stopped'],
    [
      {
        ...base,
        pendingAttention: true,
        session: { state: 'ready', activeTurnId: 'turn' },
        plan: { allDone: false },
      },
      'idle',
      'needsYou',
    ],
    [
      {
        ...base,
        plan: { executionComplete: true },
        activity: {
          confidence: 'stale',
          root: { state: 'idle' },
          subagents: [{ state: 'working', ownedProcesses: [{ state: 'detached-active' }] }],
        },
      },
      'idle',
      'complete',
    ],
    [
      {
        ...base,
        plan: { allDone: false },
        activity: {
          confidence: 'stale',
          root: { state: 'working' },
          subagents: [{ state: 'working' }],
        },
      },
      'idle',
      'incompleteWithoutContinuation',
    ],
    [
      {
        ...base,
        plan: { allDone: false },
        activity: {
          confidence: 'fresh',
          root: { state: 'idle' },
          subagents: [{ state: 'awaitingAgent' }],
        },
      },
      'working',
      'agent',
    ],
    [
      {
        ...base,
        plan: { allDone: false },
        activity: {
          confidence: 'fresh',
          root: { state: 'idle' },
          subagents: [{ state: 'idle', ownedProcesses: [{ state: 'detached-active' }] }],
        },
      },
      'working',
      'process',
    ],
    ...(['parked', 'scheduled', 'reconciling'] as const).map(
      (kind) =>
        [
          {
            ...base,
            plan: { allDone: false },
            autopilot: { health: { healthy: true, phase: kind, nextExpectedAction: 'Continue.' } },
          },
          'working',
          'autopilot',
        ] as const,
    ),
    [
      {
        ...base,
        plan: { allDone: false },
        autopilot: { state: 'safetyPaused', health: { healthy: false } },
      },
      'idle',
      'incompleteWithoutContinuation',
    ],
    [
      {
        ...base,
        activity: { confidence: 'fresh', root: { state: 'disconnected' }, subagents: [] },
      },
      'idle',
      'disconnected',
    ],
    [
      {
        ...base,
        plan: { allDone: true, executionComplete: false },
        activity: { confidence: 'fresh', root: { state: 'idle' }, subagents: [] },
      },
      'idle',
      'complete',
    ],
  ] as const)('classifies %o as %s/%s', (input, state, reason) => {
    expect(deriveSessionStatus(input as never)).toMatchObject({ state, reason, observedAt });
  });
});
