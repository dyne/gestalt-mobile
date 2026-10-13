/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import { LiveDispatchGuard } from './live-dispatch.js';
import { SqliteLiveOwnership } from './sqlite-live-ownership.js';

it('retains one real reservation during preparation and fences ordinary turns, approvals and escaped callbacks', async () => {
  const root = mkdtempSync('/tmp/live-preparation-dispatch-');
  const app = join(root, 'app');
  mkdirSync(app);
  const owners = new SqliteLiveOwnership(join(root, 'private', 'live.sqlite'), 'controller', {
    initialize: true,
  });
  const session = {
    id: 'session',
    provider: 'codex',
    threadId: 'owning-thread',
    workspacePath: app,
  } as RelaySessionSnapshot;
  let preparing = false;
  const guard = new LiveDispatchGuard({
    owners,
    scopes: () => [app],
    preflightBlocked: () => preparing,
  });
  try {
    guard.writer(session);
    expect(guard.blocked(session.id)).toBe(false);
    preparing = true;
    expect(guard.blocked(session.id)).toBe(true);
    expect(() => guard.check(session)).toThrow();
    expect(() => guard.interaction(session.id)).toThrow();
    expect(() => guard.writer(session, 'turn')).toThrow();
    let escaped!: Promise<boolean>;
    let proceed!: () => void;
    await guard.livePreparation(session, async () => {
      expect(() => guard.writer(session)).not.toThrow();
      expect(() => guard.writer(session, 'executor')).toThrow();
      expect(() => guard.writer(session, 'turn')).toThrow();
      escaped = new Promise<void>((resolve) => {
        proceed = resolve;
      }).then(() => {
        expect(() => guard.writer(session)).toThrow('LIVE_GENERATION_STALE');
        return true;
      });
    });
    proceed();
    expect(await escaped).toBe(true);
    preparing = false;
    expect(() => guard.writer(session)).not.toThrow();
  } finally {
    owners.close();
    rmSync(root, { recursive: true, force: true });
  }
});
