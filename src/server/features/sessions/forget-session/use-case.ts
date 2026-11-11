/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionForgetOperation } from '../../../../shared/contracts/session-forget.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { WorkspaceSessionConflict } from '../application/workspace-conflict.js';

export interface ForgetOperationStore {
  find(id: string): SessionForgetOperation | null;
  begin(id: string): SessionForgetOperation | null;
  update(operation: SessionForgetOperation): SessionForgetOperation;
  /** Atomically retire the roster row and complete this exact operation. */
  finalize(operation: SessionForgetOperation): SessionForgetOperation;
}

export class ForgetSession {
  private readonly pending = new Map<string, Promise<SessionForgetOperation | null>>();
  constructor(
    private readonly deps: {
      operations: ForgetOperationStore;
      find(id: string): RelaySessionSnapshot | null;
      release(session: RelaySessionSnapshot): Promise<void>;
      clean(session: RelaySessionSnapshot, operationId: string): Promise<'retained' | void>;
      changed(operation: SessionForgetOperation): void;
      now(): string;
    },
  ) {}

  execute(id: string): Promise<SessionForgetOperation | null> {
    const prior = this.pending.get(id);
    if (prior) return prior;
    const operation = this.run(id);
    this.pending.set(id, operation);
    void operation
      .finally(() => {
        if (this.pending.get(id) === operation) this.pending.delete(id);
      })
      .catch(() => undefined);
    return operation;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }

  private async run(id: string) {
    const initial = this.deps.operations.begin(id);
    if (!initial || initial.phase === 'completed') return initial;
    let operation: SessionForgetOperation = initial;
    const advance = (phase: SessionForgetOperation['phase']) => {
      operation = this.deps.operations.update({
        operationId: operation.operationId,
        sessionId: id,
        phase,
        updatedAt: this.deps.now(),
        ...(operation.scratchRetained ? { scratchRetained: true } : {}),
      });
      this.deps.changed(operation);
      return operation;
    };
    let failureCode: SessionForgetOperation['failureCode'] = 'SESSION_RELEASE_UNCONFIRMED';
    try {
      const session = this.deps.find(id);
      if (!session) throw new Error('SESSION_FORGET_FAILED');
      // Restart/retry re-enters release. Prior timestamps and process IDs prove nothing.
      if (advance('stopping').phase === 'completed') return operation;
      await this.deps.release(session);
      failureCode = 'SESSION_CLEANUP_FAILED';
      if (advance('cleaning').phase === 'completed') return operation;
      const cleanup = await this.deps.clean(session, operation.operationId);
      operation = { ...operation, scratchRetained: cleanup === 'retained' ? true : undefined };
      failureCode = 'SESSION_FORGET_FAILED';
      if (advance('finalizing').phase === 'completed') return operation;
      operation = this.deps.operations.finalize({ ...operation, updatedAt: this.deps.now() });
      this.deps.changed(operation);
      return operation;
    } catch (error) {
      operation = this.deps.operations.update({
        ...operation,
        phase: 'failed',
        failureCode,
        updatedAt: this.deps.now(),
        ...(error instanceof WorkspaceSessionConflict
          ? { blockingSessionId: error.sessionId }
          : {}),
      });
      this.deps.changed(operation);
      return operation;
    }
  }
}
