/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  parseOrgPlanAttention,
  parseOrgPlanAttentionToolResponse,
} from '../../../../shared/contracts/org-plan-attention.js';
import type { SafeInteractionOutcome } from '../../../../shared/contracts/chat-snapshot.js';
import type { PendingInteraction } from '../../sessions/model/relay-session.js';
import type { OrgPlanAttentionResolver } from './ports.js';

type Resolution = Awaited<ReturnType<OrgPlanAttentionResolver['resolve']>>;
type Input = Parameters<OrgPlanAttentionResolver['resolve']>[0];

/** The operation/claim subset of durable interaction storage consumed by resolution. */
export interface AttentionOperations {
  find(sessionId: string, requestId: string): PendingInteraction | null;
  terminalOperation(
    sessionId: string,
    requestId: string,
  ): { resolvedAt: string; outcome: SafeInteractionOutcome; operationKey: string | null } | null;
  claimOperation(
    sessionId: string,
    requestId: string,
    operationKey: string,
  ): 'claimed' | 'same' | 'stale' | 'resolved' | 'missing';
  resolved(sessionId: string, requestId: string): { resolvedAt: string } | null;
  resolutionState(sessionId: string, requestId: string): string | null;
  beginDelivery(sessionId: string, requestId: string, operationKey: string): boolean;
  retryDelivery(
    sessionId: string,
    requestId: string,
    operationKey: string,
    state?: 'active' | 'acknowledged',
  ): boolean;
  settleOperation(
    sessionId: string,
    requestId: string,
    operationKey: string,
    resolvedAt: string,
    outcome: 'answered' | 'failed',
  ): boolean;
}

export interface AttentionResolutionPorts {
  operations: AttentionOperations;
  replay: {
    find(scope: string, operationKey: string): { body: string } | null;
    remember(scope: string, operationKey: string, body: string): void;
  };
  writer: {
    available(): boolean;
    capable(sessionId: string): boolean;
    state(sessionId: string, requestId: string): 'available' | 'unavailable' | 'cleared';
    resolve(sessionId: string, requestId: string, response: unknown): boolean;
    guidance(sessionId: string): ((text: string, operationKey: string) => Promise<void>) | null;
  };
  policy: {
    authorizeReplacement(sessionId: string, canonicalTaskName: string): boolean;
    enable(sessionId: string): void;
    disable(sessionId: string): void;
  };
  publishSettlement(
    sessionId: string,
    requestId: string,
    resolvedAt: string,
    outcome: 'answered' | 'failed',
  ): void;
  now(): string;
}

/** One relay-local promise owner; durable claims and replay remain authoritative. */
export class AttentionResolution implements OrgPlanAttentionResolver {
  private readonly operations = new Map<string, Promise<Resolution>>();

  constructor(private readonly ports: AttentionResolutionPorts) {}

  async resolve(input: Input): Promise<Resolution> {
    const { sessionId, requestId, operationKey } = input;
    const scope = `org-plan-attention:${sessionId}:${requestId}`;
    const stored = this.ports.replay.find(scope, operationKey);
    if (stored) return JSON.parse(stored.body) as { kind: 'replayed'; resolvedAt: string };
    const terminal = this.ports.operations.terminalOperation(sessionId, requestId);
    if (terminal)
      return terminal.operationKey === operationKey
        ? terminal.outcome === 'failed'
          ? { kind: 'writerCleared', resolvedAt: terminal.resolvedAt }
          : { kind: 'replayed', resolvedAt: terminal.resolvedAt }
        : { kind: 'staleOperation' };
    const key = `${scope}:${operationKey}`;
    const inFlight = this.operations.get(key);
    if (inFlight) return inFlight;
    const operation = this.deliver(input, scope);
    this.operations.set(key, operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(key);
    }
  }

  private async deliver(
    { sessionId, requestId, operationKey, response }: Input,
    scope: string,
  ): Promise<Resolution> {
    const { operations, writer, policy } = this.ports;
    const interaction = operations.find(sessionId, requestId);
    if (!interaction || interaction.kind !== 'orgPlanAttention') return { kind: 'noActive' };
    const decision = parseOrgPlanAttentionToolResponse(response);
    const attention = parseOrgPlanAttention(interaction.payload);
    if (!decision || !attention) return { kind: 'staleOperation' };
    const claim = operations.claimOperation(sessionId, requestId, operationKey);
    if (claim === 'resolved') {
      const resolved = operations.resolved(sessionId, requestId);
      return resolved
        ? { kind: 'replayed', resolvedAt: resolved.resolvedAt }
        : { kind: 'staleOperation' };
    }
    if (claim === 'stale') return { kind: 'staleOperation' };
    if (claim === 'missing') return { kind: 'noActive' };
    const acknowledged = operations.resolutionState(sessionId, requestId) === 'acknowledged';
    if (acknowledged) {
      if (!operations.beginDelivery(sessionId, requestId, operationKey))
        return { kind: 'staleOperation' };
      if (
        decision.action === 'resume' &&
        attention.executorReplacement &&
        !policy.authorizeReplacement(sessionId, attention.executorReplacement.canonicalTaskName)
      ) {
        operations.retryDelivery(sessionId, requestId, operationKey, 'acknowledged');
        return { kind: 'replacementRejected' };
      }
      // The tool acknowledgement already returned; guidance is new supervisor input.
      if (decision.action === 'resume' && decision.guidance) {
        const deliver = writer.guidance(sessionId);
        if (!deliver) {
          operations.retryDelivery(sessionId, requestId, operationKey, 'acknowledged');
          return { kind: 'writerUnavailable' };
        }
        try {
          const text = `The user resolved the Autopilot attention request. Guidance:\n${decision.guidance}`;
          await deliver(text, operationKey);
        } catch {
          operations.retryDelivery(sessionId, requestId, operationKey, 'acknowledged');
          return { kind: 'writerUnavailable' };
        }
      }
      return this.settleAnswered(sessionId, requestId, operationKey, scope, decision.action);
    }
    // Durable capability belongs to the session/thread, not the relay process.
    if (!writer.capable(sessionId)) return { kind: 'legacyUnsupported' };
    if (!writer.available()) return { kind: 'writerUnavailable' };
    if (!operations.beginDelivery(sessionId, requestId, operationKey))
      return { kind: 'staleOperation' };
    if (
      decision.action === 'resume' &&
      attention.executorReplacement &&
      !policy.authorizeReplacement(sessionId, attention.executorReplacement.canonicalTaskName)
    ) {
      operations.retryDelivery(sessionId, requestId, operationKey);
      return { kind: 'replacementRejected' };
    }
    const state = writer.state(sessionId, requestId);
    if (state === 'unavailable') {
      operations.retryDelivery(sessionId, requestId, operationKey);
      return { kind: 'writerUnavailable' };
    }
    const resolvedAt = this.ports.now();
    if (state === 'cleared') {
      if (!operations.settleOperation(sessionId, requestId, operationKey, resolvedAt, 'failed'))
        return { kind: 'staleOperation' };
      this.ports.publishSettlement(sessionId, requestId, resolvedAt, 'failed');
      return { kind: 'writerCleared', resolvedAt };
    }
    if (!writer.resolve(sessionId, requestId, response)) {
      operations.retryDelivery(sessionId, requestId, operationKey);
      return { kind: 'writerUnavailable' };
    }
    return this.settleAnswered(
      sessionId,
      requestId,
      operationKey,
      scope,
      decision.action,
      resolvedAt,
    );
  }

  private settleAnswered(
    sessionId: string,
    requestId: string,
    operationKey: string,
    scope: string,
    action: 'resume' | 'disableAutopilot',
    resolvedAt = this.ports.now(),
  ): Resolution {
    if (
      !this.ports.operations.settleOperation(
        sessionId,
        requestId,
        operationKey,
        resolvedAt,
        'answered',
      )
    )
      return { kind: 'staleOperation' };
    this.ports.replay.remember(
      scope,
      operationKey,
      JSON.stringify({ kind: 'replayed', resolvedAt }),
    );
    this.ports.publishSettlement(sessionId, requestId, resolvedAt, 'answered');
    if (action === 'disableAutopilot') this.ports.policy.disable(sessionId);
    else this.ports.policy.enable(sessionId);
    return { kind: 'accepted', resolvedAt };
  }
}
