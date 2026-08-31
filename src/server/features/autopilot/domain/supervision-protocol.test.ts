/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  consumeObservableWake,
  parseSupervisionProtocolState,
  recordAutomaticContinuation,
  recoverSafetyPause,
  reportProbe,
  semanticProgressKey,
  startSupervisionProtocol,
  type SemanticProgressFacts,
  type SupervisionProtocolState,
} from './supervision-protocol.js';

const facts = (change: Partial<SemanticProgressFacts> = {}): SemanticProgressFacts => ({
  plan: { identity: 'plan-a', fingerprint: 'fingerprint-1', currentPosition: 'L1.1' },
  review: { status: 'UNREVIEWED' },
  checkpoint: { pendingTurnId: null, terminalReviewAccepted: false },
  pendingInteractions: [{ id: 'interaction-1', kind: 'approval', state: 'pending' }],
  executor: { generation: 1, state: 'working' },
  ownedProcesses: [{ id: 'process-1', state: 'running', ownerGeneration: 1 }],
  agentActivity: [{ agentId: 'root', sequence: 4, state: 'working' }],
  ...change,
});

describe('semantic supervision progress key', () => {
  it('is equal for equivalent durable observations regardless of duplicate or reordered facts', () => {
    const original = semanticProgressKey(facts());
    expect(
      semanticProgressKey(
        facts({
          pendingInteractions: [
            { id: 'interaction-2', kind: 'quiz', state: 'pending' },
            { id: 'interaction-1', kind: 'approval', state: 'pending' },
          ],
          ownedProcesses: [
            { id: 'process-2', state: 'running', ownerGeneration: 1 },
            { id: 'process-1', state: 'running', ownerGeneration: 1 },
          ],
          agentActivity: [
            { agentId: 'worker', sequence: 3, state: 'idle' },
            { agentId: 'root', sequence: 3, state: 'idle' },
            { agentId: 'root', sequence: 4, state: 'working' },
            { agentId: 'worker', sequence: 3, state: 'idle' },
          ],
        }),
      ),
    ).not.toBe(original);
    expect(
      semanticProgressKey(
        facts({
          agentActivity: [
            { agentId: 'root', sequence: 3, state: 'idle' },
            { agentId: 'root', sequence: 4, state: 'working' },
            { agentId: 'root', sequence: 4, state: 'working' },
          ],
        }),
      ),
    ).toBe(original);
  });

  it.each([
    [
      'plan identity',
      { plan: { identity: 'plan-b', fingerprint: 'fingerprint-1', currentPosition: 'L1.1' } },
    ],
    [
      'plan fingerprint',
      { plan: { identity: 'plan-a', fingerprint: 'fingerprint-2', currentPosition: 'L1.1' } },
    ],
    [
      'plan position',
      { plan: { identity: 'plan-a', fingerprint: 'fingerprint-1', currentPosition: 'L1.2' } },
    ],
    ['review', { review: { status: 'REVIEWED' } }],
    ['checkpoint', { checkpoint: { pendingTurnId: 'turn-1', terminalReviewAccepted: false } }],
    ['interaction', { pendingInteractions: [] }],
    ['executor generation', { executor: { generation: 2, state: 'working' } }],
    [
      'owned process',
      { ownedProcesses: [{ id: 'process-1', state: 'exited', ownerGeneration: 1 }] },
    ],
    ['sequenced activity', { agentActivity: [{ agentId: 'root', sequence: 5, state: 'working' }] }],
  ] as const)('changes for meaningful %s', (_name, change) => {
    expect(semanticProgressKey(facts(change))).not.toBe(semanticProgressKey(facts()));
  });

  it('does not accept timestamps or repeated prose as semantic inputs', () => {
    const key = semanticProgressKey(facts());
    expect(
      semanticProgressKey({
        ...facts(),
        agentActivity: [{ agentId: 'root', sequence: 4, state: 'working' }],
      }),
    ).toBe(key);
  });

  it('canonicalizes conflicting same-sequence observations independently of input order', () => {
    const forward = semanticProgressKey(
      facts({
        agentActivity: [
          { agentId: 'root', sequence: 4, state: 'working' },
          { agentId: 'root', sequence: 4, state: 'idle' },
        ],
      }),
    );
    const reverse = semanticProgressKey(
      facts({
        agentActivity: [
          { agentId: 'root', sequence: 4, state: 'idle' },
          { agentId: 'root', sequence: 4, state: 'working' },
        ],
      }),
    );
    expect(reverse).toBe(forward);
  });
});

describe('bounded probe protocol', () => {
  const key = semanticProgressKey(facts());
  const probed = () =>
    [0, 1, 2].reduce<SupervisionProtocolState>(
      (state) => recordAutomaticContinuation(state, key),
      startSupervisionProtocol(key),
    );

  it('requires exactly one probe on the third unchanged continuation', () => {
    const states = [0, 1, 2, 3].map((count) =>
      Array.from({ length: count }).reduce<SupervisionProtocolState>(
        (state) => recordAutomaticContinuation(state, key),
        startSupervisionProtocol(key),
      ),
    );
    expect(states.map((state) => state.outcome)).toEqual([
      'active',
      'active',
      'active',
      'probeRequired',
    ]);
    expect(recordAutomaticContinuation(states[3]!, key)).toEqual(states[3]);
  });

  it('parks only a supported structured wait and ignores duplicate reports', () => {
    const state = probed();
    const invalid = reportProbe(state, {
      id: 'bad',
      kind: 'wait',
      leaseId: 'lease-1',
      wakeConditions: [],
    });
    expect(invalid).toEqual(state);
    expect(
      reportProbe(state, {
        id: 'unknown',
        kind: 'wait',
        leaseId: 'lease-1',
        wakeConditions: ['notObservable' as never],
      }),
    ).toEqual(state);
    const parked = reportProbe(state, {
      id: 'wait-1',
      kind: 'wait',
      leaseId: 'lease-1',
      wakeConditions: ['processExited'],
    });
    expect(parked.outcome).toBe('parked');
    expect(recordAutomaticContinuation(parked, key)).toEqual(parked);
    expect(reportProbe(parked, { id: 'wait-1', kind: 'actionable' })).toEqual(parked);
  });

  it('allows immediate structured actionable work without fabricating attention', () => {
    expect(reportProbe(probed(), { id: 'action-1', kind: 'actionable' })).toMatchObject({
      outcome: 'active',
      unchangedContinuations: 0,
      lastReportId: 'action-1',
    });
  });
});

describe('one retry and safety pause', () => {
  const initialKey = semanticProgressKey(facts());
  const wakeKey = semanticProgressKey(
    facts({ ownedProcesses: [{ id: 'process-1', state: 'exited', ownerGeneration: 1 }] }),
  );
  const parked = () =>
    reportProbe(
      [0, 1, 2].reduce<SupervisionProtocolState>(
        (state) => recordAutomaticContinuation(state, initialKey),
        startSupervisionProtocol(initialKey),
      ),
      { id: 'wait-1', kind: 'wait', leaseId: 'lease-1', wakeConditions: ['processExited'] },
    );

  it('consumes only a matching durable wake and grants one retry', () => {
    const state = parked();
    expect(
      consumeObservableWake(state, {
        leaseId: 'lease-1',
        condition: 'processExited',
        progressKey: initialKey,
      }),
    ).toEqual(state);
    expect(
      consumeObservableWake(state, {
        leaseId: 'other',
        condition: 'processExited',
        progressKey: wakeKey,
      }),
    ).toEqual(state);
    expect(
      consumeObservableWake(state, {
        leaseId: 'lease-1',
        condition: 'processExited',
        progressKey: wakeKey,
      }),
    ).toMatchObject({ outcome: 'retrying', retryKey: wakeKey, waitLease: null });
  });

  it('pauses recurrence durably and allows only manual recovery', () => {
    const retrying = consumeObservableWake(parked(), {
      leaseId: 'lease-1',
      condition: 'processExited',
      progressKey: wakeKey,
    });
    const paused = recordAutomaticContinuation(retrying, wakeKey);
    expect(paused).toMatchObject({ outcome: 'safetyPaused', safetyPauseReason: 'retryRecurrence' });
    expect(
      recordAutomaticContinuation(
        paused,
        semanticProgressKey(facts({ review: { status: 'REVIEWED' } })),
      ),
    ).toEqual(paused);
    expect(parseSupervisionProtocolState(JSON.parse(JSON.stringify(paused)))).toEqual(paused);
    expect(recoverSafetyPause(paused, wakeKey)).toMatchObject({
      outcome: 'active',
      unchangedContinuations: 0,
    });
  });

  it('fails closed for malformed persisted protocol state', () => {
    const paused = recordAutomaticContinuation(
      consumeObservableWake(parked(), {
        leaseId: 'lease-1',
        condition: 'processExited',
        progressKey: wakeKey,
      }),
      wakeKey,
    );
    expect(parseSupervisionProtocolState({ ...paused, unchangedContinuations: 4 })).toBeUndefined();
    expect(
      parseSupervisionProtocolState({
        ...paused,
        outcome: 'parked',
        waitLease: { id: 'lease-1', probeKey: wakeKey, wakeConditions: ['not-observable'] },
      }),
    ).toBeUndefined();
  });

  it('returns to active supervision when the retry makes semantic progress', () => {
    const retrying = consumeObservableWake(parked(), {
      leaseId: 'lease-1',
      condition: 'processExited',
      progressKey: wakeKey,
    });
    expect(
      recordAutomaticContinuation(
        retrying,
        semanticProgressKey(facts({ review: { status: 'REVIEWED' } })),
      ),
    ).toMatchObject({ outcome: 'active' });
  });

  it('persists invalid probe-report pauses distinctly from retry recurrence', () => {
    const paused = {
      ...startSupervisionProtocol(initialKey),
      outcome: 'safetyPaused' as const,
      safetyPauseReason: 'invalidProbeReport' as const,
    };
    expect(parseSupervisionProtocolState(JSON.parse(JSON.stringify(paused)))).toEqual(paused);
  });
});
