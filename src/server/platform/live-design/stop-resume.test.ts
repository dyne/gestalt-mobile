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
import { SqliteLiveOwnership, liveAppIdentity } from './sqlite-live-ownership.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
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
  return { owners, run, events, deps, resume, restore };
}
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
