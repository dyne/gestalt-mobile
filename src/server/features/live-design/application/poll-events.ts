/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LiveFence, LiveOwnershipStore, LiveRun } from './ownership.js';

export const LIVE_POLL_KINDS = [
  'generate',
  'steer',
  'accept',
  'discard',
  'prefetch',
  'manual_edit_apply',
  'variant_mount_failed',
  'carbonize_cleanup',
  'timeout',
  'exit',
] as const;
export type LivePollKind = (typeof LIVE_POLL_KINDS)[number];
export type LivePollEvent = Record<string, unknown> & { type: LivePollKind; id?: string };
export type LiveEventReply = {
  id: string;
  status: 'done' | 'steer_done' | 'error';
  file?: string;
  data?: Record<string, unknown>;
  message?: string;
};
export type InboxStage = 'received' | 'dispatched' | 'applied' | 'acknowledged';
export type InboxEvent = {
  key: string;
  upstreamId: string | null;
  kind: LivePollKind;
  digest: string;
  stage: InboxStage;
  leaseUntil: number;
  history: readonly InboxStage[];
  reconciliation?: { disposition: 'completed' | 'discarded'; proofDigest: string };
};
/** Controller-private metadata only: no prompts, model output or bearer tokens. */
export interface LiveEventInbox {
  begin(run: LiveRun): string;
  receive(token: string, event: LivePollEvent, now: number): InboxEvent;
  advance(token: string, key: string, stage: InboxStage): void;
  knownTerminal(token: string, id: string, kind: string): boolean;
  finish(token: string): void;
  recover(token: string, code: string): void;
}
export interface CanonicalLivePoll {
  status(): Promise<unknown>;
  poll(): Promise<unknown>;
  reply(reply: LiveEventReply): Promise<unknown>;
  complete(id: string, discarded?: boolean): Promise<unknown>;
  /** End the owned helper poll and await its foreground command; never replay it. */
  settle?(): Promise<void>;
}
export interface LiveEventTurns {
  /** Interrupt the owned turn and prove root/descendant/command settlement. */
  settle?(run: LiveRun): Promise<void>;
  /** Resolves only after this existing relay's turn has completed and its result is validated. */
  apply(
    run: LiveRun,
    event: LivePollEvent,
    deadline: number,
    operationId: string,
  ): Promise<Omit<LiveEventReply, 'id'>>;
}
export interface LiveEventAuthority {
  liveEvent<T>(fence: LiveFence, eventId: string, work: () => Promise<T>): Promise<T>;
}
export function parseLivePollEvent(value: unknown): LivePollEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('LIVE_POLL_PROTOCOL_INVALID');
  const event = value as LivePollEvent;
  if (!(LIVE_POLL_KINDS as readonly unknown[]).includes(event.type))
    throw new Error('LIVE_POLL_PROTOCOL_INVALID');
  const noId = ['prefetch', 'timeout', 'exit'].includes(event.type);
  if (!noId && (typeof event.id !== 'string' || !/^[a-f0-9]{8}$/.test(event.id)))
    throw new Error('LIVE_POLL_PROTOCOL_INVALID');
  if (event.id !== undefined && (typeof event.id !== 'string' || !/^[a-f0-9]{8}$/.test(event.id)))
    throw new Error('LIVE_POLL_PROTOCOL_INVALID');
  return event;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One iteration retains its durable reservation throughout poll, turn, apply and acknowledgement.
 * No automatic takeover or replay: restart/ambiguous side effects require explicit reconciliation.
 */
export class PollLiveEvents {
  private busy = false;
  private flight: Promise<unknown> | null = null;
  constructor(
    private readonly input: {
      owners: LiveOwnershipStore;
      inbox: LiveEventInbox;
      cli: CanonicalLivePoll;
      authority: LiveEventAuthority;
      turns: LiveEventTurns;
      now(): number;
    },
  ) {}
  next(fence: LiveFence): Promise<'event' | 'timeout' | 'exit' | 'duplicate'> {
    if (this.flight) return Promise.reject(new Error('LIVE_POLL_OWNER_BUSY'));
    const flight = this.iterate(fence);
    this.flight = flight;
    void flight
      .finally(() => {
        if (this.flight === flight) this.flight = null;
      })
      .catch(() => {});
    return flight;
  }
  async settle(fence: LiveFence): Promise<void> {
    const run = this.input.owners.assert(fence);
    if (run.state !== 'stopping' && run.state !== 'recoveryRequired')
      throw new Error('LIVE_STATE_CONFLICT');
    if (!this.input.cli.settle || !this.input.turns.settle)
      throw new Error('LIVE_SETTLEMENT_UNAVAILABLE');
    // Stop's state transition has already fenced every later apply/reply.
    const flight = this.flight;
    const results = await Promise.allSettled([
      this.input.cli.settle(),
      this.input.turns.settle(run),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('LIVE_SETTLEMENT_REQUIRED');
    if (flight) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          flight.catch(() => {}),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('LIVE_SETTLEMENT_REQUIRED')), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // A previously sent native turn/start may materialize while its response is
    // settling. Observe/cancel again AFTER every dispatched effect has returned.
    await this.input.turns.settle(run);
    this.input.owners.assert(fence);
  }
  private async iterate(fence: LiveFence): Promise<'event' | 'timeout' | 'exit' | 'duplicate'> {
    if (this.busy) throw new Error('LIVE_POLL_OWNER_BUSY');
    const run = this.input.owners.assert(fence);
    if (run.state !== 'active' || run.provider !== 'codex') throw new Error('LIVE_MODE_ACTIVE');
    const token = this.input.inbox.begin(run);
    this.busy = true;
    const check = () => {
      const current = this.input.owners.assert(fence);
      if (current.state !== 'active') throw new Error('LIVE_GENERATION_STALE');
    };
    try {
      check();
      // A terminal event previously handled by the canonical CLI must never be polled again.
      const status = object(object(await this.input.cli.status())?.liveServer);
      if (!status || !Array.isArray(status.pendingEvents))
        throw new Error('LIVE_POLL_PROTOCOL_INVALID');
      for (const pending of status.pendingEvents) {
        const p = object(pending);
        if (
          p &&
          typeof p.id === 'string' &&
          typeof p.type === 'string' &&
          this.input.inbox.knownTerminal(token, p.id, p.type)
        )
          throw new Error('LIVE_POLL_DUPLICATE_TERMINAL');
      }
      check();
      // Canonical poll itself may edit during preflight or accept/discard. Verify
      // actual confinement before launching that command, as well as each model turn.
      const event = parseLivePollEvent(
        await this.input.authority.liveEvent(fence, token, () => this.input.cli.poll()),
      );
      check();
      const item = this.input.inbox.receive(token, event, this.input.now());
      if (item.stage === 'acknowledged') {
        // IDs identify sessions. Repeated identical steering could be a new user action;
        // it cannot safely be distinguished from replay at this pin.
        if (event.type === 'steer' || event.type === 'variant_mount_failed')
          throw new Error('LIVE_POLL_IDENTITY_AMBIGUOUS');
        // The upstream lease remains live until a reply. We do not manufacture a
        // new reply or repoll an acknowledged source operation without reconciliation.
        if (event.id) throw new Error('LIVE_POLL_DUPLICATE_EVENT');
        this.input.inbox.finish(token);
        if (event.type === 'exit')
          this.input.owners.mutate(fence, { event: 'recover', code: 'LIVE_BROWSER_DISCONNECTED' });
        return event.type === 'timeout' ? 'timeout' : event.type === 'exit' ? 'exit' : 'duplicate';
      }
      const advance = (stage: InboxStage) => {
        check();
        this.input.inbox.advance(token, item.key, stage);
      };
      advance('dispatched');
      if (['timeout', 'prefetch', 'exit'].includes(event.type)) {
        // Upstream removes id-less notifications when leased; these never cause edits/replies.
        advance('applied');
        advance('acknowledged');
        this.input.inbox.finish(token);
        if (event.type === 'exit')
          this.input.owners.mutate(fence, { event: 'recover', code: 'LIVE_BROWSER_DISCONNECTED' });
        return event.type === 'timeout' ? 'timeout' : event.type === 'exit' ? 'exit' : 'event';
      }
      let deadline = item.leaseUntil;
      if (event.type !== 'accept' && event.type !== 'discard') {
        const leased = object(object(await this.input.cli.status())?.liveServer);
        const pending = Array.isArray(leased?.pendingEvents) ? leased.pendingEvents : [];
        const entry = pending.map(object).find((p) => p?.id === event.id && p?.type === event.type);
        if (!entry || entry.leased !== true || typeof entry.leaseUntil !== 'number')
          throw new Error('LIVE_POLL_LEASE_EXPIRED');
        // Never extend the upstream lease based on when this controller received stdout.
        deadline = Math.min(deadline, entry.leaseUntil);
      }
      const lease = () => {
        check();
        if (this.input.now() >= deadline) throw new Error('LIVE_POLL_LEASE_EXPIRED');
      };
      if (event.type === 'accept' || event.type === 'discard') {
        // These effects already happened inside live-poll, BEFORE receipt. Lost output
        // leaves the durable poll reservation for recovery, never a new poll.
        const result = object(event._acceptResult);
        const ack = object(event._completionAck);
        if (!result || !ack || ack.ok !== true || result.mode === 'error' || ack.type === 'error')
          throw new Error('LIVE_POLL_ACCEPT_RECOVERY_REQUIRED');
        advance('applied');
        if (ack.requiresComplete === true || ack.type === 'agent_done') {
          lease();
          const cleanup = await this.input.authority.liveEvent(fence, event.id!, () =>
            this.input.turns.apply(run, event, deadline, item.key),
          );
          if (cleanup.status !== 'done') throw new Error('LIVE_POLL_ACCEPT_RECOVERY_REQUIRED');
          lease();
          const completed = object(
            await this.input.cli.complete(event.id!, event.type === 'discard'),
          );
          if (!completed || completed.ok !== true) throw new Error('LIVE_POLL_ACK_INVALID');
        } else if (result.handled !== true || !['complete', 'discarded'].includes(String(ack.type)))
          throw new Error('LIVE_POLL_ACCEPT_RECOVERY_REQUIRED');
      } else {
        lease();
        const reply = await this.input.authority.liveEvent(fence, event.id!, () =>
          this.input.turns.apply(run, event, deadline, item.key),
        );
        lease();
        advance('applied');
        if (event.type === 'carbonize_cleanup') {
          if (reply.status !== 'done') throw new Error('LIVE_POLL_ACCEPT_RECOVERY_REQUIRED');
          const completed = object(await this.input.cli.complete(event.id!));
          if (!completed || completed.ok !== true) throw new Error('LIVE_POLL_ACK_INVALID');
        } else {
          const ack = object(await this.input.cli.reply({ ...reply, id: event.id! }));
          if (!ack || ack.ok !== true || ack.id !== event.id || ack.status !== reply.status)
            throw new Error('LIVE_POLL_ACK_INVALID');
        }
      }
      // live-complete can journal an offline fallback when its server POST fails.
      // Successful CLI stdout alone therefore does not prove the live queue was acked.
      const confirmed = object(object(await this.input.cli.status())?.liveServer);
      if (
        !confirmed ||
        !Array.isArray(confirmed.pendingEvents) ||
        confirmed.pendingEvents.some((p) => {
          const row = object(p);
          return row?.id === event.id && row?.type === event.type;
        })
      )
        throw new Error('LIVE_POLL_ACK_INVALID');
      advance('acknowledged');
      this.input.inbox.finish(token);
      return 'event';
    } catch (error) {
      const code =
        error instanceof Error && /^LIVE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'LIVE_POLL_RECOVERY_REQUIRED';
      this.input.inbox.recover(token, code);
      try {
        this.input.owners.mutate(fence, { event: 'recover', code });
      } catch {
        /* stale owner never changes successor */
      }
      throw new Error(code);
    } finally {
      this.busy = false;
    }
  }
}
