/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PollLiveEvents,
  parseLivePollEvent,
  LIVE_POLL_KINDS,
  type LivePollEvent,
  type LiveEventTurns,
} from '../../features/live-design/application/poll-events.js';
import { SqliteLiveEventInbox } from './sqlite-event-inbox.js';
import { SqliteLiveOwnership, liveAppIdentity } from './sqlite-live-ownership.js';
import { LiveDispatchGuard } from './live-dispatch.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
// Exact L2 pinned poll vocabulary and canonical CLI enrichment.
const events: LivePollEvent[] = [
  {
    type: 'generate',
    id: '1234abcd',
    count: 2,
    action: 'distill',
    element: { outerHTML: '<h1>Original</h1>' },
    scaffoldAttempted: true,
  },
  { type: 'steer', id: '1234abcd', message: 'More space', pageUrl: '/page' },
  {
    type: 'accept',
    id: '1234abcd',
    variantId: '1',
    _acceptResult: { handled: true },
    _completionAck: { ok: true, type: 'complete' },
  },
  {
    type: 'discard',
    id: '1234abcd',
    _acceptResult: { handled: true },
    _completionAck: { ok: true, type: 'discarded' },
  },
  { type: 'prefetch', pageUrl: '/page' },
  { type: 'manual_edit_apply', id: '1234abcd', pageUrl: '/page', batch: { entries: [] } },
  {
    type: 'variant_mount_failed',
    id: '1234abcd',
    variant: 1,
    url: '/page',
    error: 'missing source',
  },
  {
    type: 'carbonize_cleanup',
    id: '1234abcd',
    sessionId: '1234abcd',
    file: 'index.html',
    variantId: '1',
  },
  { type: 'timeout' },
  { type: 'exit' },
];
function fixture(limit = 256) {
  const root = mkdtempSync(join(tmpdir(), 'live-inbox-'));
  const app = join(root, 'app');
  mkdirSync(app);
  const owners = new SqliteLiveOwnership(join(root, 'private', 'owners.sqlite'), 'controller', {
    initialize: true,
  });
  let run = owners.claim({
    relayId: 'relay',
    appId: 'app',
    rootThreadId: 'thread',
    provider: 'codex',
    app: liveAppIdentity(app),
    targetId: 'target',
    targetIdentity: 'socket',
    operationId: 'start',
    previewOrigin: 'https://preview.example.test:9443',
    authSessionHash: 'hash',
    deviceId: 'device',
  }).run;
  run = owners.mutate(run, { event: 'phase', phase: 'route:ack' });
  run = owners.mutate(run, { event: 'ready' });
  const path = join(root, 'private', 'inbox.sqlite');
  const inbox = new SqliteLiveEventInbox(path, limit);
  const stores = [inbox];
  cleanups.push(() => {
    for (const store of stores) store.close();
    owners.close();
    rmSync(root, { recursive: true, force: true });
  });
  let now = 1000;
  let event = events[0];
  const cli = {
    status: vi.fn(async () => ({
      liveServer: {
        pendingEvents: (event.id
          ? [{ id: event.id, type: event.type, leased: true, leaseUntil: 600000 }]
          : []) as unknown[],
      },
    })),
    poll: vi.fn(async () => event),
    reply: vi.fn(async (reply: { id: string; status: string }) => ({ ok: true, ...reply })),
    complete: vi.fn(async () => ({ ok: true })),
  };
  const verify = vi.fn(async () => {});
  const authority = new LiveDispatchGuard({
    owners,
    scopes: () => [app],
    verifyLiveRuntime: verify,
  });
  const apply = vi.fn<LiveEventTurns['apply']>(async (_run, event) => ({
    status: event.type === 'steer' ? 'steer_done' : 'done',
    ...(event.type === 'variant_mount_failed' ? { file: 'index.html' } : {}),
    ...(event.type === 'manual_edit_apply'
      ? { data: { status: 'applied', appliedEntryIds: [], failed: [], files: [], notes: [] } }
      : {}),
  }));
  const bridge = new PollLiveEvents({
    owners,
    inbox,
    cli,
    authority,
    turns: { apply },
    now: () => now,
  });
  return {
    root,
    app,
    owners,
    inbox,
    run,
    cli,
    authority,
    apply,
    bridge,
    verify,
    event(value: LivePollEvent) {
      event = value;
    },
    time(value: number) {
      now = value;
    },
    reopen() {
      const next = new SqliteLiveEventInbox(path, limit);
      stores.push(next);
      return next;
    },
  };
}
describe('canonical poll bridge', () => {
  it.each(events)(
    'handles pinned $type through canonical CLI and durable stages',
    async (event) => {
      const f = fixture();
      f.event(event);
      await f.bridge.next(f.run);
      expect(f.inbox.records()[0].history).toEqual([
        'received',
        'dispatched',
        'applied',
        'acknowledged',
      ]);
      const work = [
        'generate',
        'steer',
        'manual_edit_apply',
        'variant_mount_failed',
        'carbonize_cleanup',
      ].includes(event.type);
      expect(f.apply).toHaveBeenCalledTimes(work ? 1 : 0);
      expect(f.verify).toHaveBeenCalledTimes(work ? 2 : 1);
      expect(f.cli.reply).toHaveBeenCalledTimes(work && event.type !== 'carbonize_cleanup' ? 1 : 0);
      expect(f.cli.complete).toHaveBeenCalledTimes(event.type === 'carbonize_cleanup' ? 1 : 0);
      expect(JSON.stringify(f.inbox.records())).not.toContain('Original');
      expect(f.owners.current(f.run.liveId)?.state).toBe('active');
    },
  );
  it('matches pinned inventory and rejects push-only events and missing IDs', () => {
    expect(events.map((e) => e.type).sort()).toEqual([...LIVE_POLL_KINDS].sort());
    for (const type of ['checkpoint', 'variant_mounted', 'agent_phase', 'manual_edits', 'unknown'])
      expect(() => parseLivePollEvent({ type, id: '1234abcd' })).toThrow(
        'LIVE_POLL_PROTOCOL_INVALID',
      );
    expect(() => parseLivePollEvent({ type: 'generate' })).toThrow();
  });
  it('serializes ownership across SQLite connections and concurrent calls', async () => {
    const f = fixture();
    let release!: (value: LivePollEvent) => void;
    f.cli.poll.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const first = f.bridge.next(f.run);
    await vi.waitFor(() => expect(f.cli.poll).toHaveBeenCalled());
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_OWNER_BUSY');
    expect(() => f.reopen().begin(f.run)).toThrow('LIVE_POLL_RECOVERY_REQUIRED');
    release(events[0]);
    await first;
    expect(f.apply).toHaveBeenCalledOnce();
  });
  it('suppresses generation replay after restart despite changed preflight enrichment', async () => {
    const f = fixture();
    await f.bridge.next(f.run);
    f.event({
      ...events[0],
      scaffold: { path: 'new' },
      generationReadyAt: 99,
      _instructions: 'new',
    });
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_DUPLICATE_EVENT');
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.reopen().records()[0].stage).toBe('acknowledged');
  });
  it('distinguishes later steering but requires recovery for ambiguous identical steering', async () => {
    const f = fixture();
    f.event(events[1]);
    await f.bridge.next(f.run);
    f.event({ ...events[1], message: 'Different requested change' });
    await f.bridge.next(f.run);
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_IDENTITY_AMBIGUOUS');
    expect(f.apply).toHaveBeenCalledTimes(2);
  });
  it.each(['accept', 'discard'])(
    'blocks duplicate %s before side-effecting CLI poll',
    async (kind) => {
      const f = fixture();
      const event = events.find((e) => e.type === kind)!;
      f.event(event);
      await f.bridge.next(f.run);
      f.cli.status.mockResolvedValueOnce({
        liveServer: { pendingEvents: [{ id: event.id, type: kind }] },
      });
      await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_DUPLICATE_TERMINAL');
      expect(f.cli.poll).toHaveBeenCalledOnce();
      expect(f.owners.current(f.run.liveId)?.state).toBe('recoveryRequired');
    },
  );
  it('lost response after canonical apply cannot replay after expiry or restart', async () => {
    const f = fixture();
    const effect = vi.fn();
    f.cli.poll.mockImplementationOnce(async () => {
      effect();
      throw new Error('transport lost');
    });
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_RECOVERY_REQUIRED');
    f.time(10000000);
    expect(() => f.reopen().begin(f.run)).toThrow('LIVE_POLL_RECOVERY_REQUIRED');
    expect(effect).toHaveBeenCalledOnce();
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('lost reply retains applied stage and forbids blind source replay', async () => {
    const f = fixture();
    f.cli.reply.mockRejectedValueOnce(new Error('lost ack'));
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_RECOVERY_REQUIRED');
    expect(f.inbox.records()[0].stage).toBe('applied');
    expect(f.apply).toHaveBeenCalledOnce();
    expect(() => f.reopen().begin(f.run)).toThrow('LIVE_POLL_RECOVERY_REQUIRED');
  });
  it.each(['received', 'dispatched'] as const)(
    'unfinished %s record survives restart without automatic takeover',
    (stage) => {
      const f = fixture();
      const token = f.inbox.begin(f.run);
      const item = f.inbox.receive(token, events[0], 0);
      if (stage === 'dispatched') f.inbox.advance(token, item.key, stage);
      expect(() => f.reopen().begin({ ...f.run, controllerEpoch: 2 })).toThrow(
        'LIVE_POLL_RECOVERY_REQUIRED',
      );
    },
  );
  it('expired model lease cannot acknowledge or poll again', async () => {
    const f = fixture();
    f.apply.mockImplementationOnce(async () => {
      f.time(600000);
      return { status: 'done' };
    });
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_LEASE_EXPIRED');
    expect(f.cli.reply).not.toHaveBeenCalled();
  });
  it('stale generations have no effects', async () => {
    const f = fixture();
    await expect(f.bridge.next({ ...f.run, generation: f.run.generation - 1 })).rejects.toThrow();
    expect(f.cli.poll).not.toHaveBeenCalled();
    expect(f.owners.current(f.run.liveId)?.state).toBe('active');
  });
  it('Stop during poll prevents model dispatch and never changes successor ownership', async () => {
    const f = fixture();
    f.cli.poll.mockImplementationOnce(async () => {
      f.owners.mutate(f.run, { event: 'stop' });
      return events[0];
    });
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_GENERATION_STALE');
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.owners.current(f.run.liveId)?.state).toBe('stopping');
    expect(() => f.reopen().begin(f.run)).toThrow();
  });
  it('out-of-order accept follows upstream terminal handling without an unsolicited model turn', async () => {
    const f = fixture();
    f.event(events[2]);
    await f.bridge.next(f.run);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('carbonized accept requires fenced cleanup and gated canonical completion', async () => {
    const f = fixture();
    f.event({
      ...events[2],
      _acceptResult: { handled: true, carbonize: true },
      _completionAck: { ok: true, type: 'agent_done', requiresComplete: true },
    });
    await f.bridge.next(f.run);
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.cli.complete).toHaveBeenCalledWith('1234abcd', false);
  });
  it('failed accept ack requires recovery without retry', async () => {
    const f = fixture();
    f.event({ ...events[2], _completionAck: { ok: false } });
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_POLL_ACCEPT_RECOVERY_REQUIRED');
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('bounded capacity retains tombstones and blocks before poll', async () => {
    const f = fixture(1);
    await f.bridge.next(f.run);
    await expect(f.bridge.next(f.run)).rejects.toThrow('LIVE_INBOX_FULL');
    expect(f.cli.poll).toHaveBeenCalledOnce();
    expect(f.inbox.records()).toHaveLength(1);
  });
  it('unproven runtime confinement cannot start a model turn', async () => {
    const f = fixture();
    const authority = new LiveDispatchGuard({ owners: f.owners, scopes: () => [f.app] });
    const bridge = new PollLiveEvents({
      owners: f.owners,
      inbox: f.inbox,
      cli: f.cli,
      authority,
      turns: { apply: f.apply },
      now: () => 0,
    });
    await expect(bridge.next(f.run)).rejects.toThrow('LIVE_RUNTIME_UNISOLATED');
    expect(f.apply).not.toHaveBeenCalled();
  });
});
