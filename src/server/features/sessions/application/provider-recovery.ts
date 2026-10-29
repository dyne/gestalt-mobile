/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  isTransientProviderFailure,
  providerRetryDelayMs,
  providerRetryLimit,
  type ProviderFailure,
} from '../../../../shared/contracts/provider-failure.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';

type Episode = {
  threadId: string;
  turnId: string;
  updatedAt: string;
  attempt: number;
  authority: string;
  pending: boolean;
  cancel: () => void;
};

/** Live task recovery never enables Autopilot or recreates work after relay shutdown. */
export class SessionProviderRecovery {
  private readonly episodes = new Map<string, Episode>();

  constructor(
    private readonly deps: {
      find(id: string): RelaySessionSnapshot | null;
      authority(id: string): string | null;
      reconcile(id: string): Promise<boolean>;
      schedule(callback: () => void, delay: number): () => void;
      start(session: RelaySessionSnapshot, current: () => boolean): Promise<void>;
      publish(id: string, type: string, payload: Record<string, unknown>): void;
    },
  ) {}

  failed(session: RelaySessionSnapshot, turnId: string, failure: ProviderFailure): void {
    if (!isTransientProviderFailure(failure)) {
      this.cancel(session.id);
      return;
    }
    const authority = this.deps.authority(session.id);
    if (
      !session.threadId ||
      session.state !== 'ready' ||
      session.desiredState !== 'active' ||
      session.activeTurnId ||
      authority === null
    )
      return;
    const previous = this.episodes.get(session.id);
    if (previous?.turnId === turnId) return;
    const attempt = (previous?.attempt ?? 0) + 1;
    previous?.cancel();
    if (attempt > providerRetryLimit) {
      if (previous) previous.turnId = turnId;
      this.deps.publish(session.id, 'session.provider-retry-exhausted', {
        turnId,
        retryAttempt: providerRetryLimit,
      });
      return;
    }
    const episode: Episode = {
      threadId: session.threadId,
      turnId,
      updatedAt: session.updatedAt,
      attempt,
      authority,
      pending: true,
      cancel: () => {},
    };
    this.episodes.set(session.id, episode);
    episode.cancel = this.deps.schedule(() => {
      void this.retry(session.id, episode);
    }, providerRetryDelayMs);
    this.deps.publish(session.id, 'session.provider-retry-scheduled', {
      turnId,
      retryAttempt: attempt,
      providerFailure: failure,
    });
  }

  /** Manual sends, interruptions, successful turns and lifecycle changes end an episode. */
  cancel(id: string): void {
    this.episodes.get(id)?.cancel();
    this.episodes.delete(id);
  }

  dispose(): void {
    for (const id of this.episodes.keys()) this.cancel(id);
  }

  private current(id: string, episode: Episode): boolean {
    const session = this.deps.find(id);
    return Boolean(
      this.episodes.get(id) === episode &&
      session?.threadId === episode.threadId &&
      session.updatedAt === episode.updatedAt &&
      session.state === 'ready' &&
      session.desiredState === 'active' &&
      !session.activeTurnId &&
      this.deps.authority(id) === episode.authority,
    );
  }

  private async retry(id: string, episode: Episode): Promise<void> {
    if (this.episodes.get(id) !== episode || !episode.pending) return;
    episode.pending = false; // Duplicate timer delivery cannot dispatch a second start.
    let started = false;
    let reason = 'sessionChanged';
    try {
      if (this.current(id, episode)) {
        reason = 'activityNotIdle';
        if (await this.deps.reconcile(id)) {
          reason = 'sessionChanged';
          if (this.current(id, episode)) {
            reason = 'startUnconfirmed';
            await this.deps.start(this.deps.find(id)!, () => this.current(id, episode));
            started = true;
          }
        }
      }
    } catch {
      // An unconfirmed start is never replayed. A new terminal provider event
      // may request the next bounded attempt; transport prose is not persisted.
    }
    if (this.episodes.get(id) !== episode) return;
    this.deps.publish(
      id,
      started ? 'session.provider-retry-started' : 'session.provider-retry-abandoned',
      {
        turnId: episode.turnId,
        retryAttempt: episode.attempt,
        ...(started ? {} : { reason }),
      },
    );
  }
}
