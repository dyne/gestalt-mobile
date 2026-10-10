/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  liveAppIdentity,
  revalidateLiveApp,
  SqliteLiveOwnership,
} from '../../../platform/live-design/sqlite-live-ownership.js';
import type { LiveRun, LiveStartClaim } from '../application/ownership.js';
import { startLive, type LiveStartDependencies, type LiveStartRequest } from './use-case.js';

const fixtures: Array<{ root: string; store: SqliteLiveOwnership }> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-start-'));
  const app = join(root, 'app');
  mkdirSync(app);
  const store = new SqliteLiveOwnership(join(root, 'private', 'live.sqlite'), 'controller', {
    initialize: true,
  });
  fixtures.push({ root, store });
  const request: LiveStartRequest = {
    relayId: 'relay',
    appId: 'app',
    targetId: 'target',
    operationId: 'start',
    authSessionHash: 'session-hash',
    deviceId: 'device',
  };
  const claim: LiveStartClaim = {
    ...request,
    app: liveAppIdentity(app),
    targetIdentity: 'registered-listener',
    rootThreadId: 'thread',
    provider: 'codex',
    previewOrigin: 'https://preview.example.test:9443',
  };
  const events: string[] = [];
  let fail = '';
  let busy = false;
  let invalid = false;
  let verification = 0;
  let cleanupFailure = false;
  const action = async (name: string, run: LiveRun) => {
    events.push(name);
    expect(store.assert(run).phase).toBe(`${name}:intent`);
    if (name === fail) throw new Error('injected');
  };
  const deps: LiveStartDependencies = {
    owners: store,
    controls: {
      read: () => ({ version: 1, enabled: false, planIdentity: null }),
      hold: () => {},
      restore: () => {},
    },
    revalidateApp: revalidateLiveApp,
    admission: {
      async register() {
        events.push('register');
        if (invalid) throw new Error('LIVE_TARGET_UNREGISTERED');
        return claim;
      },
      async unregister() {
        events.push('unregister');
      },
      async busy() {
        events.push('busy');
        return busy;
      },
      async verify(run) {
        events.push('verify');
        store.assert(run);
        verification += 1;
        if (fail === `verify-${verification}`) throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
      },
    },
    resources: {
      quiesce: (run) => action('quiesce', run),
      prepare: (run) => action('prepare', run),
      authorize: (run) => action('authorize', run),
      expose: (run) => action('route', run),
      async remove() {
        events.push('remove');
        if (cleanupFailure) throw new Error('cleanup');
      },
      async revoke() {
        events.push('revoke');
      },
      async cleanup() {
        events.push('cleanup');
      },
      async restore() {
        events.push('restore');
      },
    },
  };
  return {
    request,
    claim,
    store,
    deps,
    events,
    fail: (value: string) => {
      fail = value;
    },
    busy: () => {
      busy = true;
    },
    invalid: () => {
      invalid = true;
    },
    cleanupFailure: () => {
      cleanupFailure = true;
    },
  };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

describe('fenced transactional Live Start admission', () => {
  it('registers before settling writers, authorizes before exposure, and publishes active last', async () => {
    const f = fixture();
    f.deps.resources.expose = async (run) => {
      f.events.push('route');
      expect(f.events).toContain('authorize');
      expect(f.store.read('relay')?.active).toBe(false);
      expect(f.store.assert(run).phase).toBe('route:intent');
    };
    const run = await startLive(f.deps, f.request);
    expect(f.events).toEqual([
      'register',
      'busy',
      'verify',
      'quiesce',
      'prepare',
      'authorize',
      'verify',
      'route',
    ]);
    expect(run.state).toBe('active');
    expect(f.store.read('relay')?.active).toBe(true);
  });
  it.each(['invalid', 'busy'])(
    'rejects %s admission without quiescing, routing or claiming',
    async (kind) => {
      const f = fixture();
      if (kind === 'invalid') f.invalid();
      else f.busy();
      await expect(startLive(f.deps, f.request)).rejects.toThrow(
        kind === 'invalid' ? 'LIVE_TARGET_UNREGISTERED' : 'LIVE_SESSION_BUSY',
      );
      expect(f.store.read('relay')).toBeNull();
      expect(f.events).toEqual(
        kind === 'invalid' ? ['register'] : ['register', 'busy', 'unregister'],
      );
    },
  );
  it.each([
    ['verify-1', ['unregister']],
    ['quiesce', ['restore', 'unregister']],
    ['prepare', ['cleanup', 'restore', 'unregister']],
    ['authorize', ['revoke', 'cleanup', 'restore', 'unregister']],
    ['verify-2', ['revoke', 'cleanup', 'restore', 'unregister']],
    ['route', ['remove', 'revoke', 'cleanup', 'restore', 'unregister']],
  ])(
    'rolls back %s failure in reverse acquisition order and retains a blocking claim',
    async (phase, cleanup) => {
      const f = fixture();
      f.fail(String(phase));
      await expect(startLive(f.deps, f.request)).rejects.toThrow();
      expect(f.events.slice(-cleanup.length)).toEqual(cleanup);
      expect(f.store.read('relay')?.active).toBe(false);
      expect(f.store.read('relay')?.state).toBe('error');
      expect(() => f.store.reserveWriter('relay', [f.claim.app.canonicalAppRoot])).toThrow(
        'LIVE_MODE_ACTIVE',
      );
      if (phase !== 'route') expect(f.events).not.toContain('route');
    },
  );
  it('unproved process isolation fails closed before route exposure', async () => {
    const f = fixture();
    f.fail('verify-2');
    await expect(startLive(f.deps, f.request)).rejects.toThrow('LIVE_CADDY_ADMIN_UNISOLATED');
    expect(f.events).not.toContain('route');
    expect(f.store.read('relay')?.active).toBe(false);
  });
  it('attempts the remaining rollbacks after cleanup fails and retains recoveryRequired', async () => {
    const f = fixture();
    f.fail('route');
    f.cleanupFailure();
    await expect(startLive(f.deps, f.request)).rejects.toThrow('injected');
    expect(f.events.slice(-5)).toEqual(['remove', 'revoke', 'cleanup', 'restore', 'unregister']);
    expect(f.store.read('relay')?.state).toBe('recoveryRequired');
  });
  it('double Start returns recorded progress without repeating resource acquisition', async () => {
    const f = fixture();
    const first = await startLive(f.deps, f.request);
    f.events.length = 0;
    f.busy();
    expect(await startLive(f.deps, f.request)).toEqual(first);
    expect(f.events).toEqual(['register', 'unregister']);
  });
  it('cross-session starts have one authorized winner and no loser resource acquisition', async () => {
    const f = fixture();
    f.deps.admission.register = async (request) => ({ ...f.claim, ...request });
    const results = await Promise.allSettled([
      startLive(f.deps, f.request),
      startLive(f.deps, { ...f.request, relayId: 'other' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'route')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'quiesce')).toHaveLength(1);
  });
  it('Stop during awaited acquisition fences the late acknowledgement and all stale cleanup', async () => {
    const f = fixture();
    f.deps.resources.prepare = async (run) => {
      f.events.push('prepare');
      f.store.mutate(run, { event: 'stop' });
    };
    await expect(startLive(f.deps, f.request)).rejects.toThrow('LIVE_GENERATION_STALE');
    expect(f.events).not.toContain('authorize');
    expect(f.events).not.toContain('cleanup');
    expect(f.store.read('relay')?.state).toBe('stopping');
    expect(f.store.read('relay')?.active).toBe(false);
  });
  it('controller recovery during awaited exposure cannot publish active or remove new resources', async () => {
    const f = fixture();
    f.deps.resources.expose = async (run) => {
      f.events.push('route');
      f.store.recoverController(run.controllerEpoch);
    };
    await expect(startLive(f.deps, f.request)).rejects.toThrow('LIVE_GENERATION_STALE');
    expect(f.events).not.toContain('remove');
    expect(f.store.read('relay')?.state).toBe('recoveryRequired');
    expect(f.store.read('relay')?.active).toBe(false);
  });
  it.each(['quiesce', 'prepare', 'authorize', 'expose'] as const)(
    'a crash at %s retains the durable intent and blocks a replacement Start',
    async (phase) => {
      const f = fixture();
      f.deps.resources[phase] = async (run) => {
        expect(f.store.assert(run).phase).toBe(`${phase === 'expose' ? 'route' : phase}:intent`);
        f.store.recoverController(run.controllerEpoch);
      };
      await expect(startLive(f.deps, f.request)).rejects.toThrow('LIVE_GENERATION_STALE');
      expect(f.store.read('relay')?.state).toBe('recoveryRequired');
      expect(f.store.read('relay')?.active).toBe(false);
      expect(() => f.store.claim({ ...f.claim, relayId: 'other' })).toThrow('LIVE_APP_BUSY');
      expect(f.events).not.toContain('remove');
    },
  );
  it('rejects Kimi admission without changing provider or creating resources', async () => {
    const f = fixture();
    f.deps.admission.register = async () => ({ ...f.claim, provider: 'kimi' as 'codex' });
    await expect(startLive(f.deps, f.request)).rejects.toThrow('LIVE_PROVIDER_UNSUPPORTED');
    expect(f.store.read('relay')).toBeNull();
    expect(f.events).not.toContain('quiesce');
    expect(f.events).not.toContain('route');
  });
});
