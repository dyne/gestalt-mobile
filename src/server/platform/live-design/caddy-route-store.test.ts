/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CaddyRouteStore } from './caddy-route-store.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('retains canonical origin assignments across stopped apps, process reopen, aliases and concurrent store connections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-origin-contract-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const apps = [join(dir, 'first'), join(dir, 'second'), join(dir, 'third')];
  for (const app of apps) await mkdir(app);
  const alias = join(dir, 'alias');
  await symlink(apps[0]!, alias);
  const path = join(dir, 'controller', 'origins.sqlite');
  expect(() => new CaddyRouteStore(path, 'preview.example.test', [24443, 24444])).toThrow(
    'LIVE_ORIGIN_STATE_MISSING',
  );
  const first = new CaddyRouteStore(path, 'preview.example.test', [24443, 24444], {
    initialize: true,
  });
  const assigned = first.assign(apps[0]!);
  expect(first.assign(alias).origin).toBe(assigned.origin);
  first.desire(apps[0]!, null);
  first.close();
  const reopened = new CaddyRouteStore(path, 'preview.example.test', [24443, 24444]);
  cleanup.push(() => reopened.close());
  const concurrent = new CaddyRouteStore(path, 'preview.example.test', [24443, 24444]);
  cleanup.push(() => concurrent.close());
  expect(reopened.assign(apps[0]!).origin).toBe(assigned.origin);
  expect(concurrent.assign(apps[1]!).origin).not.toBe(assigned.origin);
  expect(() => reopened.assign(apps[2]!)).toThrow('LIVE_PREVIEW_POOL_EXHAUSTED');
  expect(concurrent.list()).toHaveLength(2);
});
