/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  LiveDispatchError,
  type LiveDispatchPolicy,
} from '../../features/live-design/application/dispatch.js';
import type { LiveFence } from '../../features/live-design/application/ownership.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import { revalidateLiveApp, type SqliteLiveOwnership } from './sqlite-live-ownership.js';

type Reservation = ReturnType<SqliteLiveOwnership['reserveWriter']>;
type LiveAuthority = { fence: LiveFence; relayId: string; eventId: string; active: boolean };

/** Shared-store reservations remain durable until whole-tree quiescence is externally proved. */
export class LiveDispatchGuard implements LiveDispatchPolicy {
  private readonly writers = new Map<string, Reservation>();
  private readonly events = new AsyncLocalStorage<LiveAuthority>();
  constructor(
    private readonly input: {
      owners: SqliteLiveOwnership;
      /** Actual inherited effective scope from trusted managed runtime policy. Unknown is null. */
      scopes(session: RelaySessionSnapshot): readonly string[] | null;
      /** Verify current runtime denies collaboration/external writers without broadening permissions. */
      verifyLiveRuntime?(fence: LiveFence): Promise<void>;
    },
  ) {}
  private authority(sessionId: string): boolean {
    const authority = this.events.getStore();
    if (!authority || authority.relayId !== sessionId) return false;
    if (!authority.active) throw new LiveDispatchError('LIVE_GENERATION_STALE');
    const run = this.input.owners.assert(authority.fence);
    if (run.state !== 'active' || run.provider !== 'codex') throw new LiveDispatchError();
    revalidateLiveApp(run.app);
    return true;
  }
  check(session: RelaySessionSnapshot): void {
    if (this.authority(session.id)) return;
    try {
      this.input.owners.checkOrdinary(session.id, this.input.scopes(session));
    } catch (error) {
      throw new LiveDispatchError(
        error instanceof Error && /^LIVE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'LIVE_STATE_UNAVAILABLE',
      );
    }
  }
  writer(session: RelaySessionSnapshot, kind: 'writer' | 'turn' | 'executor' = 'writer'): void {
    if (this.authority(session.id)) {
      if (kind !== 'turn' || session.provider !== 'codex') throw new LiveDispatchError();
      return;
    }
    this.check(session);
    const existing = this.writers.get(session.id);
    try {
      if (existing) {
        this.input.owners.assertWriter(existing, this.input.scopes(session));
        return;
      }
      this.writers.set(
        session.id,
        this.input.owners.reserveWriter(session.id, this.input.scopes(session)),
      );
    } catch (error) {
      throw new LiveDispatchError(
        error instanceof Error && /^LIVE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'LIVE_STATE_UNAVAILABLE',
      );
    }
  }
  interaction(sessionId: string): void {
    if (this.authority(sessionId)) return;
    if (this.blocked(sessionId)) throw new LiveDispatchError();
  }
  blocked(sessionId: string): boolean {
    try {
      const writer = this.writers.get(sessionId);
      this.input.owners.checkOrdinary(
        sessionId,
        writer?.scopes?.map((scope) => scope.registeredPath) ?? null,
      );
      return false;
    } catch {
      return true;
    }
  }
  /** Trusted controller-only event boundary; never offered as a generic tool or HTTP flag. */
  async liveEvent<T>(fence: LiveFence, eventId: string, work: () => Promise<T>): Promise<T> {
    const run = this.input.owners.assert(fence);
    if (
      run.state !== 'active' ||
      run.provider !== 'codex' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)
    )
      throw new LiveDispatchError();
    if (!this.input.verifyLiveRuntime) throw new LiveDispatchError('LIVE_RUNTIME_UNISOLATED');
    await this.input.verifyLiveRuntime(fence);
    this.input.owners.assert(fence);
    const authority = { fence, relayId: run.relayId, eventId, active: true };
    return this.events.run(authority, async () => {
      try {
        const result = await work();
        this.input.owners.assert(fence);
        return result;
      } finally {
        authority.active = false;
      }
    });
  }
  /** Reconciliation must prove roots, descendants, approvals and command results settled. */
  settle(
    sessionId: string,
    proof: Parameters<SqliteLiveOwnership['releaseQuiescentWriter']>[1],
  ): void {
    const reservation = this.writers.get(sessionId);
    if (!reservation) throw new LiveDispatchError('LIVE_GENERATION_STALE');
    this.input.owners.releaseQuiescentWriter(reservation, proof);
    this.writers.delete(sessionId);
  }
}
