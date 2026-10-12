/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stopLive } from '../../features/live-design/stop/use-case.js';
import { resumeLive } from '../../features/live-design/resume/use-case.js';
import { LivePollLoop } from '../../features/live-design/application/poll-loop.js';
import { SqlitePreviewGrantStore } from './sqlite-preview-grant-store.js';
import { PreviewConnections } from './preview-connections.js';
import { previewSecrets } from './preview-secrets.js';
import { SqliteLiveOwnership, liveAppIdentity } from './sqlite-live-ownership.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-stop-resume-'));
  const app = join(root, 'app');
  mkdirSync(app);
  const owners = new SqliteLiveOwnership(join(root, 'private', 'owners.sqlite'), 'controller', {
    initialize: true,
  });
  cleanups.push(() => {
    owners.close();
    rmSync(root, { recursive: true, force: true });
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
    previewOrigin: 'https://preview.test:9443',
    authSessionHash: 'hash',
    deviceId: 'device',
  }).run;
  run = owners.mutate(run, { event: 'phase', phase: 'route:ack' });
  run = owners.mutate(run, { event: 'ready' });
  const events: string[] = [];
  const action = (name: string) =>
    vi.fn(async () => {
      events.push(name);
    });
  const resources = {
    revoke: action('revoke'),
    settle: action('settle'),
    remove: action('remove'),
    cleanup: action('cleanup'),
    verifyClean: action('verifyClean'),
  };
  const restore = vi.fn();
  const deps = {
    owners,
    resources,
    controls: {
      read: () => ({ version: 1, enabled: false, planIdentity: null }),
      hold: vi.fn(),
      restore,
    },
  };
  const resume = {
    owners,
    resources: {
      revoke: action('revoke'),
      settle: action('settle'),
      reconcileJournal: action('journal'),
      reconcileRoutes: action('routes'),
      verify: action('verify'),
      authorize: action('authorize'),
      expose: action('expose'),
    },
  };
  return { root, owners, run, events, deps, resume, restore };
}
it('durably denies old preview generations while Resume regrants only after reconciliation', async () => {
  const f = fixture();
  const grants = new SqlitePreviewGrantStore(join(f.root, 'home'));
  cleanups.unshift(() => grants.close());
  const grant = (run: typeof f.run, id: string) => ({
    ...run,
    grantId: id,
    tokenHash: id,
    codeChallenge: 'challenge',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  expect(grants.saveGrant(grant(f.run, 'initial'))).toBe(true);
  const connections = new PreviewConnections({
    owners: f.owners,
    store: grants,
    secrets: previewSecrets,
    authentication: { identity: () => null, authorized: () => true },
    now: () => new Date('2026-10-10T12:00:00.000Z'),
    mobileOrigin: 'https://mobile.test',
  });
  cleanups.unshift(() => connections.close());
  const lease = (run: typeof f.run, id: string) => ({
    ...run,
    leaseId: id,
    tokenHash: id,
    exchangedAt: '2026-10-10T12:00:00.000Z',
    leaseExpiresAt: '2026-10-10T12:01:00.000Z',
    absoluteExpiresAt: '2026-10-10T12:02:00.000Z',
    renewedAt: null,
  });
  const oldLease = grants.exchange('initial', () => lease(f.run, 'old-lease'))!;
  const oldClose = vi.fn();
  connections.open(oldLease, { close: oldClose });
  const recovery = f.owners.mutate(f.run, { event: 'recover', code: 'LIVE_HELPER_DIED' });
  f.resume.resources.revoke.mockImplementation(async () => {
    const run = f.owners.current(f.run.liveId)!;
    await connections.revoke({ liveId: run.liveId, throughGeneration: run.generation });
  });
  f.resume.resources.authorize.mockImplementation(async () => {
    const run = f.owners.current(f.run.liveId)!;
    expect(run.generation).toBeGreaterThan(recovery.generation);
    expect(grants.saveGrant(grant(run, 'resumed'))).toBe(true);
  });
  const resumed = await resumeLive(f.resume, recovery);
  expect(resumed.state).toBe('active');
  expect(oldClose).toHaveBeenCalledOnce();
  expect(grants.readLease('old-lease')).toBeNull();
  expect(grants.saveGrant(grant(f.run, 'old-delayed'))).toBe(false);
  expect(grants.saveGrant(grant(recovery, 'recovery-delayed'))).toBe(false);
  // An older delayed cutoff cannot revoke the newly admitted generation.
  const newLease = grants.exchange('resumed', () => lease(resumed, 'new-lease'))!;
  const newClose = vi.fn();
  connections.open(newLease, { close: newClose });
  await connections.revoke({ liveId: f.run.liveId, throughGeneration: f.run.generation });
  expect(newClose).not.toHaveBeenCalled();
  expect(grants.saveGrant(grant(resumed, 'new-generation'))).toBe(true);
  const reopened = new SqlitePreviewGrantStore(join(f.root, 'home'));
  try {
    expect(reopened.saveGrant(grant(f.run, 'restart-delayed'))).toBe(false);
  } finally {
    reopened.close();
  }
});
it('binds canonical exit to preview revocation and drain without releasing or restarting', async () => {
  const f = fixture();
  const poll = {
    next: vi.fn(async () => {
      f.owners.mutate(f.run, { event: 'recover', code: 'LIVE_BROWSER_DISCONNECTED' });
      return 'exit' as const;
    }),
    settle: vi.fn(async () => {
      f.events.push('settle');
    }),
  };
  const revoke = vi.fn(async () => {
    f.events.push('revoke');
  });
  const loop = new LivePollLoop({ owners: f.owners, poll, revocations: { revoke } });
  expect(await loop.run(f.run)).toBe('exit');
  expect(f.events).toEqual(['revoke', 'settle']);
  const recovery = f.owners.current(f.run.liveId)!;
  expect(recovery.state).toBe('recoveryRequired');
  expect(revoke).toHaveBeenCalledWith({
    liveId: recovery.liveId,
    throughGeneration: recovery.generation,
  });
  await expect(loop.run(recovery)).rejects.toThrow('LIVE_POLL_RESTART_REQUIRES_RECONCILIATION');
  expect(poll.next).toHaveBeenCalledOnce();
});
it('drains on failed revocation but retains recovery and does not replay a failed poll', async () => {
  const f = fixture();
  const poll = {
    next: vi.fn(async () => {
      throw new Error('LIVE_POLL_PROTOCOL_INVALID');
    }),
    settle: vi.fn(async () => {
      f.events.push('settle');
    }),
  };
  const loop = new LivePollLoop({
    owners: f.owners,
    poll,
    revocations: {
      revoke: async () => {
        f.events.push('revoke');
        throw new Error('stream close failed');
      },
    },
  });
  await expect(loop.run(f.run)).rejects.toThrow('stream close failed');
  expect(f.events).toEqual(['revoke', 'settle']);
  expect(f.owners.current(f.run.liveId)?.state).toBe('recoveryRequired');
  expect(poll.next).toHaveBeenCalledOnce();
});
it('manual Stop owns settlement of an in-flight loop without another poll or ownership release', async () => {
  const f = fixture();
  let rejectPoll!: (error: Error) => void;
  const pending = new Promise<'exit'>((_resolve, reject) => (rejectPoll = reject));
  const poll = {
    next: vi.fn(() => pending),
    settle: vi.fn(async () => {
      f.events.push('settle');
      rejectPoll(new Error('LIVE_GENERATION_STALE'));
    }),
  };
  const loop = new LivePollLoop({
    owners: f.owners,
    poll,
    revocations: { revoke: async () => void f.events.push('revoke') },
  });
  const work = loop.run(f.run);
  const stopping = f.owners.mutate(f.run, { event: 'stop' });
  await loop.drain(stopping);
  expect(await work).toBe('stopped');
  expect(f.events).toEqual(['revoke', 'settle']);
  expect(f.owners.current(f.run.liveId)?.state).toBe('stopping');
  expect(poll.next).toHaveBeenCalledOnce();
});
it('a late old-controller loop cannot revoke or drain a successor', async () => {
  const f = fixture();
  let resolvePoll!: (value: 'exit') => void;
  const pending = new Promise<'exit'>((resolve) => (resolvePoll = resolve));
  const poll = { next: vi.fn(() => pending), settle: vi.fn(async () => {}) };
  const revoke = vi.fn(async () => {});
  const loop = new LivePollLoop({ owners: f.owners, poll, revocations: { revoke } });
  const work = loop.run(f.run);
  f.owners.recoverController(f.run.controllerEpoch);
  const successor = f.owners.current(f.run.liveId)!;
  resolvePoll('exit');
  await expect(work).rejects.toThrow('LIVE_GENERATION_STALE');
  expect(revoke).not.toHaveBeenCalled();
  expect(poll.settle).not.toHaveBeenCalled();
  expect(f.owners.current(f.run.liveId)).toEqual(successor);
});
it('revokes and closes streams before settling work/routes/journal, then restores once', async () => {
  const f = fixture();
  const stopped = await stopLive(f.deps, f.run);
  expect(f.events).toEqual(['revoke', 'settle', 'remove', 'cleanup', 'verifyClean']);
  expect(stopped.state).toBe('idle');
  await stopLive(f.deps, stopped);
  expect(f.restore).toHaveBeenCalledOnce();
  expect(f.events).toHaveLength(5);
});
it.each(['revoke', 'settle', 'remove', 'cleanup', 'verifyClean'] as const)(
  'failed %s retains exclusive recovery ownership and retries only through Stop',
  async (phase) => {
    const f = fixture();
    f.deps.resources[phase].mockRejectedValueOnce(new Error('partial-cleanup'));
    await expect(stopLive(f.deps, f.run)).rejects.toThrow('partial-cleanup');
    const recovery = f.owners.current(f.run.liveId)!;
    expect(recovery.state).toBe('recoveryRequired');
    expect(f.restore).not.toHaveBeenCalled();
    if (phase === 'revoke') expect(f.deps.resources.settle).toHaveBeenCalledOnce();
    expect(() => f.owners.checkOrdinary('relay', [f.run.app.registeredPath])).toThrow(
      'LIVE_MODE_ACTIVE',
    );
    expect((await stopLive(f.deps, recovery)).state).toBe('idle');
    expect(f.restore).toHaveBeenCalledOnce();
  },
);
it('Resume reconciles an interrupted accept/source and partially removed routes before regrant', async () => {
  const f = fixture();
  const recovery = f.owners.mutate(f.run, {
    event: 'recover',
    code: 'LIVE_POLL_ACCEPT_RECOVERY_REQUIRED',
  });
  const resumed = await resumeLive(f.resume, recovery);
  expect(f.events).toEqual([
    'revoke',
    'settle',
    'journal',
    'routes',
    'verify',
    'authorize',
    'verify',
    'expose',
  ]);
  expect(resumed.state).toBe('active');
  expect(f.restore).not.toHaveBeenCalled();
});
it.each([
  'settle',
  'reconcileJournal',
  'reconcileRoutes',
  'verify',
  'authorize',
  'expose',
] as const)(
  'Resume failure during %s leaves access revoked and ownership retained',
  async (phase) => {
    const f = fixture();
    const recovery = f.owners.mutate(f.run, {
      event: 'recover',
      code: 'LIVE_BROWSER_DISCONNECTED',
    });
    f.resume.resources[phase].mockRejectedValueOnce(new Error('unreconciled'));
    await expect(resumeLive(f.resume, recovery)).rejects.toThrow('unreconciled');
    expect(f.events.at(-1)).toBe('revoke');
    expect(f.owners.current(recovery.liveId)?.state).toBe('recoveryRequired');
    expect(f.restore).not.toHaveBeenCalled();
  },
);
it('Resume cannot reopen an explicitly stopped generation', async () => {
  const f = fixture();
  const stopped = await stopLive(f.deps, f.run);
  await expect(resumeLive(f.resume, stopped)).rejects.toThrow('LIVE_STATE_CONFLICT');
});

it('even an undefined revocation rejection settles work and retains ownership', async () => {
  const f = fixture();
  f.deps.resources.revoke.mockRejectedValueOnce(undefined);
  const rejected = await stopLive(f.deps, f.run).then(
    () => false,
    () => true,
  );
  expect(rejected).toBe(true);
  expect(f.deps.resources.settle).toHaveBeenCalledOnce();
  expect(f.owners.current(f.run.liveId)?.state).toBe('recoveryRequired');
  expect(f.restore).not.toHaveBeenCalled();
});
