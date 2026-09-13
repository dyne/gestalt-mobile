/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from '../agent-activity/model.js';
import type { AutopilotSnapshot } from '../autopilot/domain/autopilot-session.js';
import type { SupervisedPlan } from '../plans/domain/supervised-plan.js';

export type SessionVerdictReason =
  | 'needsYou'
  | 'complete'
  | 'rootTurn'
  | 'agent'
  | 'process'
  | 'autopilot'
  | 'incompleteWithoutContinuation'
  | 'stopped'
  | 'disconnected'
  | 'unknown';

export type SessionStatus = Readonly<{
  state: 'working' | 'idle';
  reason: SessionVerdictReason;
  confidence: 'fresh' | 'stale' | 'reconciling';
  observedAt: string;
  nextExpectedAction: string;
}>;

type Input = Readonly<{
  session: Readonly<{ state: string; activeTurnId?: string | null; updatedAt?: string }>;
  plan: SupervisedPlan | null;
  activity: AgentActivitySnapshot | null;
  autopilot: AutopilotSnapshot | null;
  pendingAttention: boolean;
  observedAt: string;
}>;

/**
 * A conservative, server-owned verdict. It deliberately uses only durable
 * state and bounded activity facts: neither model prose nor opaque identity is
 * accepted as evidence of progress.
 */
export function deriveSessionStatus(input: Input): SessionStatus {
  const confidence = input.activity?.confidence ?? 'stale';
  const base = (
    state: SessionStatus['state'],
    reason: SessionVerdictReason,
    nextExpectedAction: string,
  ): SessionStatus => ({
    state,
    reason,
    confidence,
    observedAt: input.observedAt,
    nextExpectedAction,
  });
  if (input.pendingAttention || input.autopilot?.state === 'attentionRequired')
    return base('idle', 'needsYou', 'Respond to the pending request.');
  const activeProcess = input.activity?.subagents.some((agent) =>
    agent.ownedProcesses?.some(
      (process) => process.state === 'running' || process.state === 'detached-active',
    ),
  );
  const rootWorking =
    Boolean(input.session.activeTurnId) ||
    (input.activity?.confidence === 'fresh' && input.activity.root.state === 'working');
  const observedChildWorking = input.activity?.subagents.some(
    (agent) => agent.state === 'working' || agent.state === 'awaitingAgent',
  );
  // A completed plan is authoritative.  Old child/process rows are historical
  // unless their activity observation is fresh; an active root turn remains
  // direct session evidence regardless of roster freshness.
  const childWorking = input.activity?.confidence === 'fresh' ? observedChildWorking : false;
  const currentProcess = input.activity?.confidence === 'fresh' ? activeProcess : false;
  if (input.plan?.executionComplete || input.plan?.allDone) {
    if (rootWorking) return base('working', 'rootTurn', 'Wait for the active turn to settle.');
    if (childWorking) return base('working', 'agent', 'Wait for the active agent to settle.');
    if (currentProcess) return base('working', 'process', 'Wait for the owned process result.');
    return base('idle', 'complete', 'No further plan action is required.');
  }
  if (rootWorking) return base('working', 'rootTurn', 'Wait for the supervisor turn to settle.');
  if (childWorking) return base('working', 'agent', 'Wait for the active agent to settle.');
  if (currentProcess) return base('working', 'process', 'Wait for the owned process result.');
  if (input.plan && input.autopilot?.health?.healthy)
    return base('working', 'autopilot', input.autopilot.health.nextExpectedAction);
  if (input.plan)
    return base(
      'idle',
      'incompleteWithoutContinuation',
      'Resume supervision or enable a healthy Autopilot continuation.',
    );
  if (input.activity?.root.state === 'disconnected')
    return base('idle', 'disconnected', 'Restore or reopen the session.');
  if (input.session.state === 'stopped' || input.session.state === 'released')
    return base('idle', 'stopped', 'Open the session to continue.');
  return base('idle', 'unknown', 'Refresh session status.');
}
