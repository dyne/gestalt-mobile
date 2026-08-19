/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  createAgentActivitySnapshot,
  clearAgentActivityChildren,
  projectAgentActivity,
  withActivityConfidence,
  type AgentActivityFact,
  type AgentActivitySnapshot,
} from './model.js';

/** Session-local read model. Scheduling and reconciliation are injected ports. */
export class AgentActivityRegistry {
  readonly #snapshots = new Map<string, AgentActivitySnapshot>();
  readonly #timers = new Map<string, () => void>();
  readonly #generation = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<void>>();
  constructor(
    private readonly publish: (snapshot: AgentActivitySnapshot, occurredAt: string) => void,
    private readonly options: {
      now?: () => string;
      schedule?: (callback: () => void, delayMs: number) => () => void;
      staleAfterMs?: number;
      retryDelaysMs?: readonly number[];
      maxReconcileAttempts?: number;
      diagnostic?: (sessionId: string, code: 'reconcileExhausted') => void;
      reconcile?: (sessionId: string) => Promise<void>;
    } = {},
  ) {}

  snapshot(sessionId: string, now: string): AgentActivitySnapshot {
    return this.#snapshots.get(sessionId) ?? createAgentActivitySnapshot(sessionId, now);
  }
  observe(fact: AgentActivityFact): AgentActivitySnapshot {
    const current = this.snapshot(fact.sessionId, fact.occurredAt);
    const next = withActivityConfidence(
      projectAgentActivity(current, fact),
      fact.kind === 'collaboration' && !fact.childId ? 'stale' : 'fresh',
    );
    if (next !== current) {
      this.#snapshots.set(fact.sessionId, next);
      this.publish(next, fact.occurredAt);
    }
    this.#generation.set(fact.sessionId, (this.#generation.get(fact.sessionId) ?? 0) + 1);
    this.#armStaleness(fact.sessionId);
    return next;
  }
  reconciling(sessionId: string, occurredAt: string): AgentActivitySnapshot {
    return this.#qualify(sessionId, occurredAt, 'reconciling');
  }
  disconnected(sessionId: string, occurredAt: string): AgentActivitySnapshot {
    this.suspend(sessionId);
    const current = this.snapshot(sessionId, occurredAt);
    const next = withActivityConfidence(
      clearAgentActivityChildren(
        projectAgentActivity(current, { sessionId, occurredAt, kind: 'processExited' }),
      ),
      'stale',
    );
    if (next !== current) {
      this.#snapshots.set(sessionId, next);
      this.publish(next, occurredAt);
    }
    return next;
  }
  suspend(sessionId: string): void {
    this.#timers.get(sessionId)?.();
    this.#timers.delete(sessionId);
    this.#generation.set(sessionId, (this.#generation.get(sessionId) ?? 0) + 1);
    // The RPC cannot be cancelled, but a restart must not coalesce onto its
    // obsolete promise. Generation guards suppress its eventual result.
    this.#inFlight.delete(sessionId);
  }
  reconciled(sessionId: string, occurredAt: string): AgentActivitySnapshot {
    return this.#qualify(sessionId, occurredAt, 'fresh');
  }
  refresh(sessionId: string): Promise<void> {
    if (!this.options.reconcile) return Promise.resolve();
    const existing = this.#inFlight.get(sessionId);
    if (existing) return existing;
    const generation = (this.#generation.get(sessionId) ?? 0) + 1;
    this.#generation.set(sessionId, generation);
    const running = this.#attempt(sessionId, generation, 1).finally(() => {
      if (this.#inFlight.get(sessionId) === running) this.#inFlight.delete(sessionId);
    });
    this.#inFlight.set(sessionId, running);
    return running;
  }
  /** Replaces the observed direct-child set; absent children are disconnected. */
  childrenReconciled(
    sessionId: string,
    occurredAt: string,
    children: readonly {
      id: string;
      status?: string;
      qualified?: boolean;
      nickname?: string;
      role?: string;
    }[],
  ): AgentActivitySnapshot {
    let next = this.snapshot(sessionId, occurredAt);
    const seen = new Set(children.map((child) => child.id));
    for (const child of children)
      next = projectAgentActivity(next, {
        sessionId,
        occurredAt,
        kind: 'collaboration',
        childId: child.id,
        childThreadId: child.id,
        ...(child.status ? { childStatus: child.status } : {}),
        ...(child.nickname ? { childNickname: child.nickname } : {}),
        ...(child.role ? { childRole: child.role } : {}),
      });
    for (const child of next.subagents)
      if (!seen.has(child.id))
        next = projectAgentActivity(next, {
          sessionId,
          occurredAt,
          kind: 'collaboration',
          childId: child.id,
          childStatus: 'notLoaded',
        });
    // A malformed/unknown `thread/list` row is not proof that a child is
    // healthy. Preserve it as disconnected but keep the aggregate qualified
    // only as stale until a later authoritative read succeeds.
    next = withActivityConfidence(
      next,
      children.some((child) => child.qualified === false) ? 'stale' : 'fresh',
    );
    const current = this.snapshot(sessionId, occurredAt);
    if (next !== current) {
      this.#snapshots.set(sessionId, next);
      this.publish(next, occurredAt);
    }
    return next;
  }
  dispose(sessionId: string): void {
    this.#snapshots.delete(sessionId);
    this.#timers.get(sessionId)?.();
    this.#timers.delete(sessionId);
    this.#generation.delete(sessionId);
    this.#inFlight.delete(sessionId);
  }

  #armStaleness(sessionId: string): void {
    if (!this.options.schedule || !this.options.reconcile) return;
    this.#timers.get(sessionId)?.();
    this.#timers.set(
      sessionId,
      this.options.schedule(
        () => void this.refresh(sessionId),
        this.options.staleAfterMs ?? 30_000,
      ),
    );
  }

  async #attempt(sessionId: string, generation: number, attempt: number): Promise<void> {
    if (this.#generation.get(sessionId) !== generation) return;
    this.#timers.delete(sessionId);
    const now = this.options.now?.() ?? new Date().toISOString();
    this.reconciling(sessionId, now);
    try {
      await this.options.reconcile?.(sessionId);
      if (this.#generation.get(sessionId) === generation)
        this.reconciled(sessionId, this.options.now?.() ?? now);
    } catch {
      if (this.#generation.get(sessionId) !== generation) return;
      const delays = this.options.retryDelaysMs ?? [1_000, 5_000, 15_000];
      if (
        attempt >=
        Math.min(this.options.maxReconcileAttempts ?? delays.length + 1, delays.length + 1)
      ) {
        this.options.diagnostic?.(sessionId, 'reconcileExhausted');
        this.disconnected(sessionId, this.options.now?.() ?? now);
        return;
      }
      this.#timers.set(
        sessionId,
        this.options.schedule!(
          () => void this.#attempt(sessionId, generation, attempt + 1),
          delays[attempt - 1]!,
        ),
      );
    }
  }

  #qualify(
    sessionId: string,
    occurredAt: string,
    confidence: 'fresh' | 'reconciling' | 'stale',
    fact?: Pick<AgentActivityFact, 'kind'>,
  ): AgentActivitySnapshot {
    const current = this.snapshot(sessionId, occurredAt);
    const next = fact
      ? withActivityConfidence(
          projectAgentActivity(current, { sessionId, occurredAt, ...fact }),
          confidence,
        )
      : withActivityConfidence(current, confidence);
    if (next !== current) {
      this.#snapshots.set(sessionId, next);
      this.publish(next, occurredAt);
    }
    return next;
  }
}
