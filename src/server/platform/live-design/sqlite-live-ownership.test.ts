/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveStartClaim } from '../../features/live-design/application/ownership.js';
import { liveAppIdentity, SqliteLiveOwnership } from './sqlite-live-ownership.js';

const fixtures: Array<{ root: string; stores: SqliteLiveOwnership[] }> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-ownership-'));
  const app = join(root, 'app');
  const other = join(root, 'other');
  mkdirSync(app);
  mkdirSync(other);
  const path = join(root, 'private', 'live.sqlite');
  const store = new SqliteLiveOwnership(path, 'controller', { initialize: true });
  const second = new SqliteLiveOwnership(path, 'controller');
  fixtures.push({ root, stores: [store, second] });
  const claim = (relayId = 'relay-a', appRoot = app): LiveStartClaim => ({
    relayId,
    appId: 'app',
    app: liveAppIdentity(appRoot),
    targetId: 'target',
    targetIdentity: 'listener-start-1',
    rootThreadId: 'thread',
    provider: 'codex',
    operationId: 'start-1',
    previewOrigin: 'https://preview.example.test:9443',
    authSessionHash: 'session-hash',
    deviceId: 'device',
  });
  return { root, app, other, path, store, second, claim };
}
afterEach(() => {
  for (const { root, stores } of fixtures.splice(0)) {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('shared durable Live ownership', () => {
  it('atomically claims both relay and app across independent Mobile connections', () => {
    const f = fixture();
    const first = f.store.claim(f.claim()).run;
    expect(() => f.second.claim(f.claim('relay-b'))).toThrow('LIVE_APP_BUSY');
    expect(f.second.read('relay-b')).toBeNull();
    expect(f.second.claim(f.claim('relay-b', f.other)).run.state).toBe('starting');
    expect(() =>
      f.second.claim({ ...f.claim('relay-a', f.other), operationId: 'start-2' }),
    ).toThrow('LIVE_MODE_ACTIVE');
    expect(f.second.current(first.liveId)).toEqual(first);
  });
  it('serializes truly concurrent claims from two independent OS processes', async () => {
    const f = fixture();
    const script = `import {SqliteLiveOwnership} from ${JSON.stringify(new URL('./sqlite-live-ownership.ts', import.meta.url).href)};
      const store = new SqliteLiveOwnership(${JSON.stringify(f.path)}, 'controller');
      try { console.log(JSON.stringify({run:store.claim(JSON.parse(process.argv[1])).run})); }
      catch (error) { console.log(JSON.stringify({error:error.message})); } finally { store.close(); }`;
    const results = await Promise.all(
      ['relay-a', 'relay-b'].map(async (relay) => {
        const { stdout } = await promisify(execFile)(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          script,
          JSON.stringify(f.claim(relay)),
        ]);
        return JSON.parse(stdout.trim());
      }),
    );
    expect(results.filter((result) => result.run)).toHaveLength(1);
    expect(results.filter((result) => result.error === 'LIVE_APP_BUSY')).toHaveLength(1);
  });
  it('canonicalizes aliases, includes ancestor/descendant scopes and avoids sibling-prefix false positives', () => {
    const f = fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.app, alias);
    const child = join(f.app, 'child');
    mkdirSync(child);
    f.store.claim(f.claim());
    for (const path of [alias, child])
      expect(() => f.second.claim(f.claim('relay-b', path))).toThrow('LIVE_APP_BUSY');
    expect(() => f.second.claim(f.claim('relay-b', f.root))).toThrow('LIVE_PRIVATE_STATE_INVALID');
    const sibling = `${f.app}-other`;
    mkdirSync(sibling);
    expect(f.second.claim(f.claim('relay-b', sibling)).acquired).toBe(true);
  });
  it('returns original progress for the same operation without another generation and rejects body/owner reuse', () => {
    const f = fixture();
    const first = f.store.claim(f.claim());
    expect(f.second.claim(f.claim())).toEqual({ run: first.run, acquired: false });
    for (const change of [
      { targetId: 'other' },
      { appId: 'other' },
      { deviceId: 'other' },
      { authSessionHash: 'other' },
    ])
      expect(() => f.second.claim({ ...f.claim(), ...change })).toThrow('IDEMPOTENCY_KEY_REUSED');
  });
  it.each(['starting', 'active', 'stopping', 'error', 'recoveryRequired'] as const)(
    '%s blocks both scopes and ordinary writers',
    (state) => {
      const f = fixture();
      let run = f.store.claim(f.claim()).run;
      if (state === 'active') {
        run = f.store.mutate(run, { event: 'phase', phase: 'route:ack' });
        run = f.store.mutate(run, { event: 'ready' });
      }
      if (state === 'stopping') run = f.store.mutate(run, { event: 'stop' });
      if (state === 'error')
        run = f.store.mutate(run, { event: 'failed', code: 'LIVE_START_FAILED' });
      if (state === 'recoveryRequired')
        run = f.store.mutate(run, { event: 'recover', code: 'LIVE_CONTROLLER_LOST' });
      expect(run.state).toBe(state);
      expect(() => f.second.reserveWriter('relay-b', [f.root])).toThrow('LIVE_MODE_ACTIVE');
      expect(() => f.second.reserveWriter('relay-a', [f.other])).toThrow('LIVE_MODE_ACTIVE');
      expect(() => f.second.claim(f.claim('relay-b'))).toThrow('LIVE_APP_BUSY');
    },
  );
  it.each(['roots', 'descendants', 'commands', 'approvals', 'unknown'] as const)(
    'does not release a writer with outstanding %s',
    (key) => {
      const f = fixture();
      const writer = f.store.reserveWriter('relay-b', [f.root]);
      const quiet = { roots: 0, descendants: 0, commands: 0, approvals: 0, unknown: false };
      expect(() =>
        f.store.releaseQuiescentWriter(writer, { ...quiet, [key]: key === 'unknown' ? true : 1 }),
      ).toThrow('LIVE_SESSION_BUSY');
      expect(() => f.second.claim(f.claim())).toThrow('LIVE_SESSION_BUSY');
      f.store.releaseQuiescentWriter(writer, quiet);
      expect(f.second.claim(f.claim()).acquired).toBe(true);
      expect(() => f.store.releaseQuiescentWriter(writer, quiet)).toThrow('LIVE_GENERATION_STALE');
    },
  );
  it('unknown scope is busy and unrelated proven scopes remain independently usable', () => {
    const f = fixture();
    const unknown = f.store.reserveWriter('relay-b', null);
    expect(() => f.second.claim(f.claim())).toThrow('LIVE_SESSION_BUSY');
    f.store.releaseQuiescentWriter(unknown, {
      roots: 0,
      descendants: 0,
      commands: 0,
      approvals: 0,
      unknown: false,
    });
    f.store.reserveWriter('relay-b', [f.other]);
    expect(f.second.claim(f.claim()).acquired).toBe(true);
  });
  it('treats retargeted writer aliases as unknown and rejects retargeted app identity', () => {
    const f = fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.app, alias);
    const original = liveAppIdentity(alias);
    f.store.reserveWriter('relay-b', [alias]);
    rmSync(alias);
    symlinkSync(f.other, alias);
    expect(() => f.second.claim({ ...f.claim(), app: original })).toThrow(
      'LIVE_APP_IDENTITY_CHANGED',
    );
    // The old canonical scope cannot authorize a newly retargeted effective write scope.
    expect(() => f.second.claim(f.claim('relay-c', f.other))).toThrow('LIVE_SESSION_BUSY');
  });
  it('does not replay completed old Start progress over a newer owner', () => {
    const f = fixture();
    const old = f.store.claim(f.claim()).run;
    const stop = f.store.mutate(old, { event: 'stop' });
    f.store.mutate(stop, { event: 'cleaned' });
    f.store.claim({ ...f.claim(), operationId: 'start-2' });
    expect(() => f.second.retry(f.claim())).toThrow('LIVE_GENERATION_STALE');
  });
  it('opening a store preserves claims; explicit controller recovery fences late actions', () => {
    const f = fixture();
    const old = f.store.claim(f.claim()).run;
    f.second.recoverController(old.controllerEpoch);
    const recovered = f.second.current(old.liveId)!;
    expect(recovered.state).toBe('recoveryRequired');
    expect(recovered.generation).toBeGreaterThan(old.generation);
    expect(() => f.store.mutate(old, { event: 'stop' })).toThrow('LIVE_GENERATION_STALE');
    expect(() => f.store.recoverController(old.controllerEpoch)).toThrow('LIVE_GENERATION_STALE');
    expect(() => f.store.claim(f.claim('relay-c', f.other))).toThrow('LIVE_GENERATION_STALE');
    expect(() => f.store.reserveWriter('relay-c', [f.other])).toThrow('LIVE_GENERATION_STALE');
    expect(() => f.second.claim(f.claim('relay-b'))).toThrow('LIVE_APP_BUSY');
  });
  it('fences stale revisions, forbids ready before route acknowledgement, and releases only explicit cleanup', () => {
    const f = fixture();
    const old = f.store.claim(f.claim()).run;
    expect(() => f.store.mutate(old, { event: 'ready' })).toThrow('LIVE_STATE_CONFLICT');
    const stop = f.store.mutate(old, { event: 'stop' });
    expect(() => f.second.mutate(old, { event: 'ready' })).toThrow('LIVE_GENERATION_STALE');
    const idle = f.store.mutate(stop, { event: 'cleaned' });
    const next = f.second.claim({ ...f.claim(), operationId: 'start-2' }).run;
    expect(next.generation).toBeGreaterThan(idle.generation);
    expect(() => f.store.mutate(idle, { event: 'ready' })).toThrow('LIVE_STATE_CONFLICT');
  });
  it('revalidates inode identity before preview authorization and rejects replacement app roots', () => {
    const f = fixture();
    f.store.claim(f.claim());
    renameSync(f.app, join(f.root, 'old-app'));
    mkdirSync(f.app);
    expect(() => f.store.read('relay-a')).toThrow('LIVE_APP_IDENTITY_CHANGED');
    expect(() => f.second.claim(f.claim('relay-b'))).toThrow('LIVE_APP_BUSY');
  });
  it('fails closed for lost, corrupt, version-mismatched and foreign controller state', () => {
    const f = fixture();
    expect(() => new SqliteLiveOwnership(join(f.root, 'missing.sqlite'), 'controller')).toThrow(
      'LIVE_STATE_UNAVAILABLE',
    );
    expect(() => new SqliteLiveOwnership(f.path, 'other')).toThrow('LIVE_STATE_UNAVAILABLE');
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE live_controller SET version=2').run();
    expect(() => f.store.claim(f.claim())).toThrow('LIVE_STATE_UNAVAILABLE');
    db.prepare('UPDATE live_controller SET version=1').run();
    f.store.claim(f.claim());
    db.prepare("UPDATE live_runs SET record='{}'").run();
    db.close();
    expect(() => f.store.read('relay-a')).toThrow('LIVE_STATE_UNAVAILABLE');
    expect(() => f.second.reserveWriter('relay-b', [f.other])).toThrow('LIVE_STATE_UNAVAILABLE');
  });
  it('retains legacy native catalog reservations while allowing ordinary admission', () => {
    const f = fixture();
    const db = new DatabaseSync(f.path);
    db.prepare('INSERT INTO live_writers VALUES (?,?,NULL)').run(
      'a56b99de-476b-4c41-847d-a3b59a43ee00',
      'relay-native-auxiliary',
    );
    db.close();
    const discovery = f.second.reserveAuxiliary('relay-native-auxiliary');
    expect(discovery).toMatchObject({
      id: 'a56b99de-476b-4c41-847d-a3b59a43ee00',
      scopes: null,
      auxiliary: true,
    });
    expect(() => f.store.reserveWriter('relay-native-auxiliary', null)).toThrow(
      'LIVE_SESSION_BUSY',
    );
    const writer = f.store.reserveWriter('relay-a', [f.app]);
    expect(() => f.second.reserveWriter('unknown-writer', null)).toThrow('LIVE_SESSION_BUSY');
    f.store.releaseQuiescentWriter(writer, {
      roots: 0,
      descendants: 0,
      commands: 0,
      approvals: 0,
      unknown: false,
    });
    expect(() => f.second.claim(f.claim())).toThrow('LIVE_SESSION_BUSY');
    expect(f.store.reserveAuxiliary('relay-native-auxiliary')).toEqual(discovery);
  });
  it('shares auxiliary discovery admission across connections without weakening Live exclusion or ordinary writer fences', () => {
    const f = fixture();
    const discovery = f.store.reserveAuxiliary('catalog');
    expect(f.second.reserveAuxiliary('catalog')).toEqual(discovery);
    const writer = f.second.reserveWriter('relay-a', [f.app]);
    const other = f.store.reserveWriter('relay-b', [f.other]);
    expect(f.second.reserveAuxiliary('other-catalog').scopes).toBeNull();
    expect(() => f.store.reserveWriter('relay-c', [f.app])).toThrow('LIVE_SESSION_BUSY');
    expect(() => f.store.claim(f.claim())).toThrow('LIVE_SESSION_BUSY');
    const quiet = { roots: 0, descendants: 0, commands: 0, approvals: 0, unknown: false };
    f.second.releaseQuiescentWriter(writer, quiet);
    f.store.releaseQuiescentWriter(other, quiet);
    // Discovery closure is not tree proof; even without ordinary writers Live remains excluded.
    expect(() => f.store.claim(f.claim())).toThrow('LIVE_SESSION_BUSY');
    expect(() => f.store.releaseQuiescentWriter(discovery, { ...quiet, commands: 1 })).toThrow(
      'LIVE_SESSION_BUSY',
    );
    f.store.assertWriter(discovery, null);
    f.second.recoverController(1);
    expect(() => f.store.reserveAuxiliary('catalog')).toThrow('LIVE_GENERATION_STALE');
  });
});
