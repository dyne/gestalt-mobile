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
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexSessionRuntime, type AppServer } from '../codex/session-runtime.js';

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
    guard.settle(session.id, {
      roots: 0,
      descendants: 0,
      commands: 0,
      approvals: 0,
      unknown: false,
    });
    await expect(guard.livePreparation(session, async () => {})).rejects.toThrow(
      'LIVE_RUNTIME_UNISOLATED',
    );
    guard.reacquirePreparation(session);
    await guard.livePreparation(session, async () => {
      expect(() => guard.writer(session)).not.toThrow();
      expect(() => guard.writer(session, 'turn')).toThrow();
    });
    preparing = false;
    expect(() => guard.reacquirePreparation(session)).toThrow('LIVE_RUNTIME_UNISOLATED');
    expect(() => guard.writer(session)).not.toThrow();
  } finally {
    owners.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('holds all writers until original startup admission completes, including quiescent scope narrowing', async () => {
  const root = mkdtempSync('/tmp/live-startup-admission-'),
    app = join(root, 'app');
  mkdirSync(app);
  const owners = new SqliteLiveOwnership(join(root, 'private/live.sqlite'), 'controller', {
    initialize: true,
  });
  let preparing = false,
    scopes: readonly string[] | null = null;
  const guard = new LiveDispatchGuard({
    owners,
    scopes: () => scopes,
    preflightBlocked: () => preparing,
  });
  const calls: string[] = [];
  const server: AppServer = {
    close() {},
    rpc: {
      request: async (method) => {
        calls.push(method);
        return method === 'thread/start' ? { thread: { id: 'root' } } : {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
  };
  const args: ConstructorParameters<typeof CodexSessionRuntime> = [() => server];
  args[14] = guard;
  let entered!: () => void, seal!: () => void;
  const admissionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const admissionSealed = new Promise<void>((resolve) => {
    seal = resolve;
  });
  args[15] = async (session) => {
    entered();
    await admissionSealed;
    guard.narrowQuiescentWriter(session.id, [app], {
      roots: 0,
      descendants: 0,
      commands: 0,
      approvals: 0,
      unknown: false,
    });
    scopes = [app];
  };
  args[18] = {
    run: async (session, work) => {
      guard.writer(session);
      preparing = true;
      try {
        return await guard.livePreparation(session, work);
      } finally {
        preparing = false;
      }
    },
  };
  const runtime = new CodexSessionRuntime(...args);
  const session = RelaySession.create({
    id: 'owner',
    provider: 'codex',
    workspaceId: 'app',
    workspacePath: app,
    profile: 'default',
    model: 'selected',
    effectiveSkillSelection: { skills: [] },
    now: 'time',
  }).snapshot;
  try {
    const started = runtime.start(session, 'time');
    await admissionEntered;
    expect(preparing).toBe(true);
    expect(() => guard.writer({ ...session, threadId: 'root' }, 'turn')).toThrow(
      'LIVE_MODE_ACTIVE',
    );
    expect(calls).not.toContain('turn/start');
    seal();
    const ready = await started;
    expect(preparing).toBe(false);
    expect(() => guard.writer(ready, 'turn')).not.toThrow();
  } finally {
    seal();
    runtime.stopAll();
    owners.close();
    rmSync(root, { recursive: true, force: true });
  }
});
