/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  isForgetCleanupFolder,
  type SessionForgetOperation,
} from '../../../../shared/contracts/session-forget.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { WorkspaceSessionConflict } from '../application/workspace-conflict.js';

export class ForgetRecoveryUnavailable extends Error {}

export interface ForgetOperationStore {
  find(id: string): SessionForgetOperation | null;
  begin(id: string, keepFilesFor?: string): SessionForgetOperation | null;
  update(operation: SessionForgetOperation): SessionForgetOperation;
  /** Atomically retire the roster row and complete this exact operation. */
  finalize(operation: SessionForgetOperation): SessionForgetOperation;
}

export class WorkspaceCleanupFailure extends Error {
  constructor(
    readonly folders: readonly string[],
    cause: unknown,
  ) {
    super('SESSION_CLEANUP_FAILED', { cause });
  }
}

export type ForgetCleanupResult =
  void | 'retained' | { scratchRetained?: true; release(): Promise<void> };

export class ForgetSession {
  private readonly pending = new Map<string, Promise<SessionForgetOperation | null>>();
  constructor(
    private readonly deps: {
      operations: ForgetOperationStore;
      find(id: string): RelaySessionSnapshot | null;
      release(session: RelaySessionSnapshot): Promise<void>;
      clean(session: RelaySessionSnapshot, operationId: string): Promise<ForgetCleanupResult>;
      changed(operation: SessionForgetOperation): void;
      now(): string;
    },
  ) {}

  execute(id: string, keepFilesFor?: string): Promise<SessionForgetOperation | null> {
    const prior = this.pending.get(id);
    if (prior) {
      if (keepFilesFor !== undefined) {
        const current = this.deps.operations.find(id);
        if (current?.operationId !== keepFilesFor || !current.keepFilesRequested)
          return Promise.reject(new ForgetRecoveryUnavailable());
      }
      return prior;
    }
    const operation = this.run(id, keepFilesFor);
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

  private async run(id: string, keepFilesFor?: string) {
    const initial = this.deps.operations.begin(id, keepFilesFor);
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
    let releaseCleanup: (() => Promise<void>) | undefined;
    try {
      const session = this.deps.find(id);
      if (!session) throw new Error('SESSION_FORGET_FAILED');
      // Restart/retry re-enters release. Prior timestamps and process IDs prove nothing.
      if (advance('stopping').phase === 'completed') return operation;
      await this.deps.release(session);
      failureCode = 'SESSION_CLEANUP_FAILED';
      let cleanup: ForgetCleanupResult = 'retained';
      if (!initial.keepFilesRequested) {
        if (advance('cleaning').phase === 'completed') return operation;
        cleanup = await this.deps.clean(session, operation.operationId);
      }
      if (cleanup && typeof cleanup === 'object') releaseCleanup = () => cleanup.release();
      operation = {
        ...operation,
        scratchRetained: cleanup === 'retained' ? true : cleanup?.scratchRetained,
      };
      failureCode = 'SESSION_FORGET_FAILED';
      if (advance('finalizing').phase === 'completed') return operation;
      operation = this.deps.operations.finalize({ ...operation, updatedAt: this.deps.now() });
      this.deps.changed(operation);
      return operation;
    } catch (error) {
      const cleanupFolders =
        failureCode === 'SESSION_CLEANUP_FAILED' && error instanceof WorkspaceCleanupFailure
          ? error.folders.filter(isForgetCleanupFolder)
          : [];
      operation = this.deps.operations.update({
        ...operation,
        phase: 'failed',
        failureCode,
        updatedAt: this.deps.now(),
        ...(error instanceof WorkspaceSessionConflict
          ? { blockingSessionId: error.sessionId }
          : {}),
        ...(cleanupFolders.length ? { cleanupFolders } : {}),
      });
      this.deps.changed(operation);
      return operation;
    } finally {
      await releaseCleanup?.();
    }
  }
}
