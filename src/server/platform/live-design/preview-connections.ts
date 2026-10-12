/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  LiveAudience,
  PreviewGrantDependencies,
  PreviewLease,
  PreviewRevocationBarrier,
  PreviewRevocationScope,
} from '../../features/live-design/application/ports.js';
import { leaseValid, sameAudience } from '../../features/live-design/application/grants.js';

export interface OwnedPreviewConnection {
  /** Must stop forwarding synchronously, then resolve after the actual transport has closed. */
  close(): void | Promise<void>;
}
export interface PreviewConnectionPermit {
  /** Check before every upstream chunk or message, not only at handshake. */
  active(): boolean;
  /** Normal transport disconnect unregisters without invoking revocation again. */
  release(): void;
}
type Entry = {
  audience: PreviewLease;
  deadline: number;
  connection: OwnedPreviewConnection;
  timer?: ReturnType<typeof setTimeout>;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

/** One registry per controller process. Durable denial is shared; other processes observe it within 5s. */
export class PreviewConnections implements PreviewRevocationBarrier {
  private readonly entries = new Set<Entry>();
  private readonly closing = new Map<Entry, Promise<void>>();
  private stopped = false;
  readonly revalidationMs: number;
  constructor(
    private readonly deps: PreviewGrantDependencies,
    revalidationMs = 5000,
  ) {
    if (!Number.isInteger(revalidationMs) || revalidationMs < 1 || revalidationMs > 5000)
      throw new Error('Preview revalidation must not exceed five seconds');
    this.revalidationMs = revalidationMs;
  }
  get size(): number {
    return this.entries.size;
  }
  open(lease: PreviewLease, connection: OwnedPreviewConnection): PreviewConnectionPermit {
    if (this.stopped) throw new Error('Preview controller has stopped');
    const entry: Entry = {
      audience: { ...lease },
      connection,
      closed: false,
      deadline: Math.min(
        Date.parse(lease.leaseExpiresAt),
        Date.parse(lease.absoluteExpiresAt),
        this.deps.now().getTime() + 60_000,
      ),
    };
    this.entries.add(entry);
    // The maximum physical forwarding lifetime cannot grow if the wall clock moves backward.
    entry.lifetimeTimer = setTimeout(
      () => {
        void this.closeEntry(entry).catch(() => {});
      },
      Math.max(0, entry.deadline - this.deps.now().getTime()),
    );
    entry.lifetimeTimer.unref();
    const active = () => {
      if (entry.closed) return false;
      try {
        const current = this.deps.store.readLease(lease.leaseId);
        const now = this.deps.now();
        if (
          now.getTime() < entry.deadline &&
          current &&
          current.tokenHash === lease.tokenHash &&
          sameAudience(current, lease) &&
          leaseValid(this.deps, current, lease.previewOrigin, now.toISOString()) &&
          this.deps.now().getTime() < entry.deadline
        )
          return true;
      } catch {
        /* Store/controller failure closes the stream; it never grants a grace period. */
      }
      void this.closeEntry(entry).catch(() => {});
      return false;
    };
    const schedule = () => {
      if (!active()) return;
      entry.timer = setTimeout(
        () => {
          if (active()) schedule();
        },
        Math.min(this.revalidationMs, entry.deadline - this.deps.now().getTime()),
      );
      entry.timer.unref();
    };
    schedule();
    return { active, release: () => this.release(entry) };
  }
  async revoke(scope: PreviewRevocationScope): Promise<void> {
    // Barrier survives Stop/restart and prevents another process minting for the stopped run.
    this.deps.store.revoke(scope);
    const waiting: Promise<void>[] = [];
    for (const entry of this.entries)
      if (matches(entry.audience, scope)) waiting.push(this.closeEntry(entry));
    for (const [entry, pending] of this.closing)
      if (matches(entry.audience, scope)) waiting.push(pending);
    await Promise.all(waiting);
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const entry of this.entries) void this.closeEntry(entry).catch(() => {});
    await Promise.all(this.closing.values());
  }
  private release(entry: Entry): void {
    entry.closed = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.lifetimeTimer) clearTimeout(entry.lifetimeTimer);
    this.entries.delete(entry);
  }
  private closeEntry(entry: Entry): Promise<void> {
    if (entry.closed) return this.closing.get(entry) ?? Promise.resolve();
    this.release(entry); // Writes are denied before transport IO/await.
    let result: void | Promise<void>;
    try {
      result = entry.connection.close();
    } catch (error) {
      result = Promise.reject(error);
    }
    const closing = Promise.resolve(result).then(() => undefined);
    this.closing.set(entry, closing);
    // Retain failed closure evidence so a later Stop cannot falsely claim completed cleanup.
    void closing.then(
      () => this.closing.delete(entry),
      () => {},
    );
    return closing;
  }
}
function matches(audience: LiveAudience, scope: PreviewRevocationScope): boolean {
  if ('authSessionHash' in scope) return audience.authSessionHash === scope.authSessionHash;
  if ('deviceId' in scope) return audience.deviceId === scope.deviceId;
  return audience.liveId === scope.liveId;
}
