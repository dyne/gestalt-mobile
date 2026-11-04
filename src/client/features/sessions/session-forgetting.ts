/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionForgetOperation } from '../../../shared/contracts/session-forget.js';
import type { RelaySession } from './relay-client.js';

export type SessionForgetState = Readonly<{
  phase: SessionForgetOperation['phase'] | 'requesting';
  operation?: SessionForgetOperation;
}>;

export function isSessionForgetting(state: SessionForgetState | undefined): boolean {
  return state !== undefined && state.phase !== 'failed' && state.phase !== 'completed';
}

function isForgetOperation(value: unknown, id: string): value is SessionForgetOperation {
  if (!value || typeof value !== 'object') return false;
  const operation = value as SessionForgetOperation;
  return (
    operation.sessionId === id &&
    typeof operation.operationId === 'string' &&
    typeof operation.updatedAt === 'string' &&
    ['stopping', 'cleaning', 'finalizing', 'failed', 'completed'].includes(operation.phase)
  );
}

/** One RelayApp's owner-specific workflow; only a server acknowledgement retires a frame. */
export class SessionForgetting {
  #states = new Map<string, SessionForgetState>();
  #sessions = new Map<string, RelaySession>();
  #requests = new Map<string, Promise<void>>();
  #completed = new Set<string>();
  #announcedFailures = new Set<string>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #disposed = false;

  constructor(
    private readonly options: {
      relay: {
        forgetSession(id: string): Promise<void>;
        getSession(id: string): Promise<RelaySession>;
      };
      publish(states: ReadonlyMap<string, SessionForgetState>): void;
      onComplete(session: RelaySession): void;
      onError(error: unknown): void;
      pollMs?: number;
    },
  ) {}

  isBusy(id: string): boolean {
    return isSessionForgetting(this.#states.get(id));
  }

  /** Ignore a late roster read that began before a confirmed deletion. */
  reconcile(sessions: RelaySession[]): RelaySession[] {
    const current = sessions.filter((session) => !this.#completed.has(session.id));
    for (const session of current) {
      this.#sessions.set(session.id, session);
      if (session.forgetOperation) this.observe(session.id, session.forgetOperation);
    }
    // A list missing an owner does not settle an outstanding request. Its own
    // authoritative GET/DELETE will confirm completion, including after reconnect.
    for (const [id, state] of this.#states) {
      const retained = this.#sessions.get(id);
      if (isSessionForgetting(state) && retained && !current.some((item) => item.id === id))
        current.push(retained);
    }
    return current.filter((session) => !this.#completed.has(session.id));
  }

  observe(id: string, operation: unknown): void {
    if (this.#disposed || !isForgetOperation(operation, id) || this.#completed.has(id)) return;
    const previous = this.#states.get(id)?.operation;
    if (previous && previous.updatedAt > operation.updatedAt) return;
    if (operation.phase === 'completed') {
      this.#finish(id);
      return;
    }
    this.#set(id, { phase: operation.phase, operation });
    if (operation.phase === 'failed') {
      this.#error(id, operation.failureCode, `${operation.operationId}:${operation.updatedAt}`);
    }
  }

  forget(session: RelaySession): Promise<void> {
    if (this.#disposed || this.#completed.has(session.id)) return Promise.resolve();
    const running = this.#requests.get(session.id);
    if (running) return running;
    if (this.isBusy(session.id)) return Promise.resolve();
    this.#sessions.set(session.id, session);
    this.#announcedFailures.delete(`${session.id}:request`);
    this.#set(session.id, { phase: 'requesting' });
    const task = this.#request(session.id);
    this.#requests.set(session.id, task);
    void task.finally(() => this.#requests.delete(session.id));
    return task;
  }

  async #request(id: string): Promise<void> {
    try {
      await this.options.relay.forgetSession(id);
      this.#finish(id);
    } catch (error) {
      if (this.#disposed || this.#completed.has(id)) return;
      // A lost response is not a failed backend operation. Recover its durable
      // phase before unlocking the owner or inviting a retry.
      try {
        const current = await this.options.relay.getSession(id);
        if (current.forgetOperation) {
          this.observe(id, current.forgetOperation);
          return;
        }
      } catch (readError) {
        if (this.#isMissing(readError)) {
          this.#finish(id);
          return;
        }
        // Keep an indeterminate owner busy until the relay can confirm its state.
        this.#error(id, error);
        return;
      }
      this.#set(id, { phase: 'failed' });
      this.#error(id, error);
    }
  }

  #set(id: string, state: SessionForgetState): void {
    if (this.#disposed) return;
    this.#states.set(id, state);
    this.options.publish(new Map(this.#states));
    if (isSessionForgetting(state)) this.#schedule(id);
    else this.#clearTimer(id);
  }

  #schedule(id: string): void {
    if (this.#timers.has(id) || this.#disposed) return;
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id);
        void this.#poll(id);
      }, this.options.pollMs ?? 1000),
    );
  }

  async #poll(id: string): Promise<void> {
    try {
      const current = await this.options.relay.getSession(id);
      if (!this.#disposed && this.isBusy(id) && current.forgetOperation)
        this.observe(id, current.forgetOperation);
      else if (!this.#disposed && this.isBusy(id) && !this.#requests.has(id)) {
        this.#set(id, { phase: 'failed' });
        this.#error(id, new Error('SESSION_FORGET_FAILED'));
      }
    } catch (error) {
      if (this.#isMissing(error)) this.#finish(id);
      // A disconnected transport leaves the last durable phase intact.
    } finally {
      if (this.isBusy(id)) this.#schedule(id);
    }
  }

  #isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
  }

  #error(id: string, error: unknown, key = `${id}:request`): void {
    if (this.#announcedFailures.has(key)) return;
    this.#announcedFailures.add(key);
    this.options.onError(typeof error === 'string' ? new Error(error) : error);
  }

  #finish(id: string): void {
    if (this.#disposed || this.#completed.has(id)) return;
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#completed.add(id);
    this.#states.delete(id);
    this.#clearTimer(id);
    this.options.publish(new Map(this.#states));
    this.options.onComplete(session);
  }

  #clearTimer(id: string): void {
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
  }

  dispose(): void {
    this.#disposed = true;
    for (const id of this.#timers.keys()) this.#clearTimer(id);
  }
}
