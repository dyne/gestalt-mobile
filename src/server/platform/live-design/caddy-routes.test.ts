/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CaddyRouteStore } from './caddy-route-store.js';
import { CaddyRoutes } from './caddy-routes.js';
import { RegisteredPreviewTargets } from './preview-targets.js';
import { realCaddyFixture } from './caddy-routes.fixture.js';
import { UnixCaddyAdmin } from './caddy-admin.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(poolSize = 3) {
  const fixture = await realCaddyFixture();
  cleanup.push(() => fixture.close());
  const store = new CaddyRouteStore(
    join(fixture.dir, 'routes.sqlite'),
    'preview.example.test',
    fixture.ports.slice(0, poolSize),
  );
  cleanup.push(() => store.close());
  const targets = new RegisteredPreviewTargets();
  const ids = fixture.appRoots.map((appRoot) =>
    targets.register({
      appRoot,
      appPort: 31231,
      helperPort: 31232,
      gatewayPort: fixture.gatewayPort,
    }),
  );
  return {
    ...fixture,
    store,
    targets,
    ids,
    routes: new CaddyRoutes(fixture.admin, store, targets),
  };
}
describe.runIf(Boolean(process.env.LIVE_TEST_CADDY))('real isolated Caddy route ownership', () => {
  it('creates namespaced TLS gateway routes and tears down idempotently without recycling origins', async () => {
    const f = await setup(2);
    const first = await f.routes.activate(f.appRoots[0]!, f.ids[0]!);
    expect(await f.routes.activate(f.appRoots[0]!, f.ids[0]!)).toMatchObject(first);
    const servers = (await f.admin.request('GET', '/config/apps/http/servers')).body as Record<
      string,
      unknown
    >;
    expect(servers.unrelated).toEqual(f.unrelated);
    expect(JSON.stringify(servers[first.serverId])).toContain(`127.0.0.1:${f.gatewayPort}`);
    expect(JSON.stringify(servers[first.serverId])).not.toContain('31231');
    expect((await f.raw('GET', `/id/${first.serverId}_helper`)).status).toBe(200);
    await f.routes.remove(f.appRoots[0]!);
    await f.routes.remove(f.appRoots[0]!);
    expect((await f.raw('GET', `/id/${first.serverId}_app`)).status).toBe(404);
    const second = await f.routes.activate(f.appRoots[1]!, f.ids[1]!);
    expect(second.origin).not.toBe(first.origin); // Old service workers/storage cannot receive app two.
    await expect(f.routes.activate(f.appRoots[2]!, f.ids[2]!)).rejects.toThrow(
      'LIVE_PREVIEW_POOL_EXHAUSTED',
    );
    expect(await f.routes.activate(f.appRoots[0]!, f.ids[0]!)).toMatchObject(first);
  }, 15000);
  it('rejects arbitrary loopback target selection and crossed app registrations', async () => {
    const f = await setup();
    await expect(f.routes.activate(f.appRoots[0]!, 'http://127.0.0.1:2019')).rejects.toThrow(
      'LIVE_TARGET_UNREGISTERED',
    );
    await expect(f.routes.activate(f.appRoots[1]!, f.ids[0]!)).rejects.toThrow(
      'LIVE_TARGET_UNREGISTERED',
    );
    expect(f.store.list()).toEqual([]);
  }, 15000);
  it('removes orphaned routes after an application directory disappeared, retaining its origin', async () => {
    const f = await setup();
    const assignment = await f.routes.activate(f.appRoots[0]!, f.ids[0]!);
    await rm(f.appRoots[0]!, { recursive: true });
    await f.routes.remove(f.appRoots[0]!);
    expect((await f.raw('GET', `/id/${assignment.serverId}`)).status).toBe(404);
    expect(f.store.read(f.appRoots[0]!)?.origin).toBe(assignment.origin);
  }, 15000);
  it('reconciles missing IDs, Caddyfile reload and restart using durable desired state', async () => {
    const f = await setup();
    const first = await f.routes.activate(f.appRoots[0]!, f.ids[0]!);
    await f.raw('DELETE', `/id/${first.serverId}`);
    await f.routes.reconcile();
    expect((await f.raw('GET', `/id/${first.serverId}`)).status).toBe(200);
    await promisify(execFile)(process.env.LIVE_TEST_CADDY ?? 'caddy', [
      'reload',
      '--config',
      f.caddyfile,
      '--adapter',
      'caddyfile',
      '--address',
      `unix/${f.socket}`,
    ]);
    expect((await f.raw('GET', `/id/${first.serverId}`)).status).toBe(404);
    // Reload retained no TLS issuance policy; reinstall operator policy in this fixture only.
    await f.raw('POST', '/config/apps/tls', f.baseline.apps.tls);
    await f.routes.reconcile();
    expect((await f.raw('GET', `/id/${first.serverId}`)).status).toBe(200);
    await f.stop();
    await f.start();
    const reopened = new CaddyRouteStore(
      join(f.dir, 'routes.sqlite'),
      'preview.example.test',
      f.ports,
    );
    cleanup.push(() => reopened.close());
    await new CaddyRoutes(f.admin, reopened, f.targets).reconcile();
    expect(reopened.read(f.appRoots[0]!)?.origin).toBe(first.origin);
    await expect(
      new CaddyRoutes(f.admin, reopened, new RegisteredPreviewTargets()).reconcile(),
    ).rejects.toThrow('LIVE_TARGET_UNREGISTERED');
    expect(
      ((await f.admin.request('GET', '/config/apps/http/servers')).body as Record<string, unknown>)
        .unrelated,
    ).toEqual(f.unrelated);
  }, 20000);
  it('uses real ETags to preserve concurrent unrelated changes and bounds retries', async () => {
    const f = await setup();
    const original = f.admin.request.bind(f.admin);
    let mutations = 0;
    f.admin.request = async (method, path, etag, body) => {
      if (method !== 'GET' && mutations++ === 0)
        await f.raw('POST', '/config/apps/http/servers/concurrent', {
          listen: [
            `127.0.0.1:${await import('./caddy-routes.fixture.js').then((m) => m.freePort())}`,
          ],
          routes: [],
          automatic_https: { disable: true },
        });
      return original(method, path, etag, body);
    };
    await f.routes.activate(f.appRoots[0]!, f.ids[0]!);
    expect(mutations).toBe(2);
    expect(
      ((await f.admin.request('GET', '/config/apps/http/servers')).body as Record<string, unknown>)
        .concurrent,
    ).toBeDefined();
    f.admin.request = async (method, path, etag, body) =>
      method === 'GET' ? original(method, path, etag, body) : { status: 412, body: null };
    await expect(f.routes.activate(f.appRoots[1]!, f.ids[1]!)).rejects.toThrow(
      'LIVE_CADDY_CONFLICT_RETRIES_EXHAUSTED',
    );
  }, 15000);
  it('rejects foreign ownership and listener/OS port conflicts; malformed updates roll back', async () => {
    const f = await setup();
    const assignment = f.store.assign(f.appRoots[0]!);
    await f.raw('POST', '/config/apps/http/servers/collision', {
      listen: [`127.0.0.1:${assignment.port}`],
      routes: [],
      automatic_https: { disable: true },
    });
    await expect(f.routes.activate(f.appRoots[0]!, f.ids[0]!)).rejects.toThrow(
      'LIVE_PREVIEW_PORT_CONFLICT',
    );
    await f.raw('DELETE', '/config/apps/http/servers/collision');
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(assignment.port, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    await expect(f.routes.activate(f.appRoots[0]!, f.ids[0]!)).rejects.toThrow(
      'LIVE_CADDY_UPDATE_FAILED',
    );
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await f.routes.reconcile();
    const before = await f.admin.request('GET', '/config/apps/http/servers');
    expect(
      (
        await f.admin.request(
          'PATCH',
          `/config/apps/http/servers/${assignment.serverId}`,
          before.etag,
          { invalid_field: true },
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await f.admin.request('GET', '/config/apps/http/servers')).body).toEqual(before.body);
    await f.raw('POST', `/config/apps/http/servers/${assignment.serverId}/routes/0/handle`, {
      handler: 'static_response',
      body: 'foreign',
    });
    await expect(f.routes.remove(f.appRoots[0]!)).rejects.toThrow('LIVE_CADDY_OWNERSHIP_CONFLICT');
    await expect(f.admin.request('DELETE', '/config/', before.etag)).rejects.toThrow(
      'LIVE_CADDY_OPERATION_REJECTED',
    );
    expect(() => new UnixCaddyAdmin('http://localhost:2019')).toThrow();
  }, 15000);
});
