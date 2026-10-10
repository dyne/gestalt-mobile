/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutopilotCoordinator } from '../../features/autopilot/application/service.js';
import { defaultAutopilotPolicy } from '../../features/autopilot/application/policy.js';
import { createAgentActivitySnapshot } from '../../features/agent-activity/model.js';
import { migrate } from '../persistence/migrate.js';
import { SqliteAutopilotStore } from '../persistence/sqlite-autopilot-store.js';
import { SqliteSessionRepository } from '../persistence/sqlite-session-repository.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { liveAppIdentity, SqliteLiveOwnership } from './sqlite-live-ownership.js';
import { AutopilotLiveControls } from './autopilot-live-controls.js';
import { stopLive, type LiveStopDependencies } from '../../features/live-design/stop/use-case.js';
import { startLive } from '../../features/live-design/start/use-case.js';
import type { LiveRun } from '../../features/live-design/application/ownership.js';

const fixtures: Array<{
  root: string;
  db: DatabaseSync;
  owners: SqliteLiveOwnership;
  ownersClosed?: boolean;
  coordinator: AutopilotCoordinator;
}> = [];
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
  const root = mkdtempSync(join(tmpdir(), 'live-autopilot-'));
  const app = join(root, 'app');
  mkdirSync(app);
  let owners = new SqliteLiveOwnership(join(root, 'private', 'live.sqlite'), 'controller', {
    initialize: true,
  });
  const db = new DatabaseSync(join(root, 'relay.sqlite'));
  migrate(db);
  const store = new SqliteAutopilotStore(db);
  const now = () => new Date().toISOString();
  new SqliteSessionRepository(db).save(
    RelaySession.create({
      id: 'relay',
      provider: 'codex',
      workspaceId: 'workspace',
      workspacePath: app,
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: now(),
    }).bindThread('root', now()).snapshot,
  );
  const plan = {
    title: 'plan',
    steps: [
      {
        id: 'l1',
        title: 'l1',
        level: 1 as const,
        state: 'WIP' as const,
        priority: 'A' as const,
        reviewStatus: 'UNREVIEWED' as const,
        description: {},
        children: [],
      },
    ],
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
    executionComplete: false,
    currentStepId: 'l1',
  };
  const base = createAgentActivitySnapshot('relay', now());
  const activity = {
    ...base,
    confidence: 'fresh' as const,
    root: { ...base.root, state: 'idle' as const },
  };
  const start = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const terminate = vi.fn(async () => true);
  let planIdentity: string | null = 'plan-identity';
  const dependencies: ConstructorParameters<typeof AutopilotCoordinator>[0] = {
    store,
    now,
    policy: defaultAutopilotPolicy,
    plan: () => (planIdentity ? { plan, identity: planIdentity } : null),
    session: () => ({ state: 'ready', threadId: 'root', activeTurnId: null }),
    activity: () => activity,
    pendingInteraction: () => false,
    liveHeld: () => {
      try {
        owners.checkOrdinary('relay', [app]);
        return false;
      } catch {
        return true;
      }
    },
    schedule: (work, delay) => {
      const timer = setTimeout(work, delay);
      return () => clearTimeout(timer);
    },
    nextControlId: (_session, generation) => `control-${generation}`,
    turnStarter: { start },
    executorController: {
      resume,
      terminateProcess: terminate,
      interrupt: async () => true,
      refresh: async () => {},
      transferProcess: () => {},
      consumeProcess: () => {},
    },
    reconcile: async () => ({ compatible: true }),
    publish: () => {},
  };
  let coordinator = new AutopilotCoordinator(dependencies);
  fixtures.push({ root, db, owners, coordinator });
  const claimInput = {
    relayId: 'relay',
    rootThreadId: 'root',
    provider: 'codex' as const,
    appId: 'app',
    app: liveAppIdentity(app),
    targetId: 'target',
    targetIdentity: 'listener',
    operationId: 'start',
    previewOrigin: 'https://preview.example.test:9443',
    authSessionHash: 'hash',
    deviceId: 'device',
  };
  const claim = () => owners.claim(claimInput);
  return {
    get coordinator() {
      return coordinator;
    },
    store,
    get owners() {
      return owners;
    },
    claim,
    claimInput,
    start,
    resume,
    terminate,
    invalidatePlan: (kind: 'replaced' | 'removed' | 'completed') => {
      if (kind === 'completed') plan.executionComplete = true;
      else planIdentity = kind === 'removed' ? null : 'other-plan';
    },
    restartOwners: () => {
      owners.close();
      owners = new SqliteLiveOwnership(join(root, 'private', 'live.sqlite'), 'controller');
      fixtures.at(-1)!.owners = owners;
      owners.recoverController(1);
      return owners;
    },
    restartCoordinator: () => {
      coordinator.dispose('relay');
      coordinator = new AutopilotCoordinator(dependencies);
      fixtures.at(-1)!.coordinator = coordinator;
    },
  };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.coordinator.dispose('relay');
    f.db.close();
    if (!f.ownersClosed) f.owners.close();
    rmSync(f.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

function lifecycle(f: ReturnType<typeof fixture>) {
  const controls = new AutopilotLiveControls(f.coordinator, f.owners);
  const clean = vi.fn(async () => {});
  const deps: LiveStopDependencies = {
    owners: f.owners,
    controls,
    resources: { remove: clean, revoke: clean, cleanup: clean, verifyClean: clean },
  };
  const takeOver = () =>
    startLive(
      {
        owners: f.owners,
        controls,
        revalidateApp: () => {},
        admission: {
          register: async () => f.claimInput,
          unregister: clean,
          busy: async () => false,
          verify: clean,
        },
        resources: {
          quiesce: clean,
          restore: clean,
          prepare: clean,
          cleanup: clean,
          authorize: clean,
          revoke: clean,
          expose: clean,
          remove: clean,
        },
      },
      f.claimInput,
    );
  return { controls, deps, takeOver, clean };
}

describe('versioned prior control restoration through durable adapters', () => {
  it.each(['replaced', 'removed', 'completed'] as const)(
    'does not revive prior intent when the current plan is %s',
    async (kind) => {
      const f = fixture();
      f.coordinator.enable('relay');
      const l = lifecycle(f);
      const active = await l.takeOver();
      f.invalidatePlan(kind);
      await stopLive(l.deps, active);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    'preserves prior On=%s and releases only after cleanup proof',
    async (enabled) => {
      const f = fixture();
      if (enabled) f.coordinator.enable('relay');
      else f.coordinator.disable('relay');
      const l = lifecycle(f);
      const before = l.controls.read('relay');
      const active = await l.takeOver();
      expect(active.priorControls).toEqual(before);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.start).not.toHaveBeenCalled();
      const stopped = await stopLive(l.deps, active);
      expect(stopped.state).toBe('idle');
      expect(stopped.controlsRestored).toBe(true);
      expect(l.controls.read('relay').enabled).toBe(enabled);
      f.owners.checkOrdinary('relay', [f.claimInput.app.registeredPath]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.start).toHaveBeenCalledTimes(enabled ? 1 : 0);
      await stopLive(l.deps, stopped);
      f.coordinator.restore('relay');
      f.coordinator.restore('relay');
      expect(f.start).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );
  it('manual Off during Live changes the durable version and defeats the old On snapshot', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    const l = lifecycle(f);
    const active = await l.takeOver();
    f.coordinator.disable('relay');
    expect(l.controls.read('relay').version).toBeGreaterThan(active.priorControls!.version);
    const stopped = await stopLive(l.deps, active);
    expect(stopped.state).toBe('idle');
    f.coordinator.restore('relay');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.store.find('relay')?.stopReason).toBe('manualDisabled');
    expect(f.start).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
  });
  it.each(['remove', 'revoke', 'cleanup', 'verifyClean'] as const)(
    'interrupted %s keeps ownership until verified reconciliation',
    async (phase) => {
      const f = fixture();
      f.coordinator.enable('relay');
      const l = lifecycle(f);
      const active = await l.takeOver();
      l.deps.resources[phase] = async () => {
        throw new Error('interrupted');
      };
      await expect(stopLive(l.deps, active)).rejects.toThrow('interrupted');
      const interrupted = f.owners.current(active.liveId)!;
      expect(interrupted.state).toBe('recoveryRequired');
      expect(interrupted.phase).toBe(`stop:${phase}:intent`);
      expect(() => f.owners.checkOrdinary('relay', [f.claimInput.app.registeredPath])).toThrow(
        'LIVE_MODE_ACTIVE',
      );
      f.coordinator.restore('relay');
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.start).not.toHaveBeenCalled();
      const repaired = lifecycle(f);
      expect((await stopLive(repaired.deps, interrupted)).state).toBe('idle');
    },
  );
  it('restart before release retains the snapshot and fences a late Stop callback', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    const l = lifecycle(f);
    const active = await l.takeOver();
    let finish!: () => void;
    l.deps.resources.verifyClean = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const pending = stopLive(l.deps, active);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    f.restartOwners();
    const recovered = f.owners.current(active.liveId)!;
    expect(recovered.state).toBe('recoveryRequired');
    expect(recovered.priorControls).toEqual(active.priorControls);
    finish();
    await expect(pending).rejects.toThrow();
    expect(f.owners.current(active.liveId)).toEqual(recovered);
    f.coordinator.restore('relay');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.start).not.toHaveBeenCalled();
    const repaired = lifecycle(f);
    expect((await stopLive(repaired.deps, recovered)).state).toBe('idle');
  });
  it('a stale cleaned Stop cannot restore controls into a newer Live generation', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    const l = lifecycle(f);
    const active = await l.takeOver();
    const stopped = await stopLive(l.deps, active);
    const newer = f.owners.claim({ ...f.claimInput, operationId: 'next' }).run;
    await expect(stopLive(l.deps, stopped)).rejects.toThrow('LIVE_GENERATION_STALE');
    expect(f.owners.current(newer.liveId)).toEqual(newer);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('crash after release before restoration replays no duplicate continuation', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    const l = lifecycle(f);
    const active = await l.takeOver();
    const realRestore = l.controls.restore.bind(l.controls);
    l.controls.restore = (run: LiveRun) => {
      realRestore(run);
      throw new Error('crash-after-restore');
    };
    await expect(stopLive(l.deps, active)).rejects.toThrow('crash-after-restore');
    const pending = f.owners.current(active.liveId)!;
    expect(pending.state).toBe('idle');
    expect(pending.controlsRestored).toBe(false);
    f.restartOwners();
    f.restartCoordinator();
    const replacement = f.owners.current(active.liveId)!;
    expect(replacement.state).toBe('idle');
    expect(replacement.priorControls).toEqual(pending.priorControls);
    expect(() => f.owners.assert(pending)).toThrow('LIVE_GENERATION_STALE');
    const repaired = lifecycle(f);
    await stopLive(repaired.deps, replacement);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('pending restoration stays older than a subsequent claim across controller takeover', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    const l = lifecycle(f);
    const active = await l.takeOver();
    l.controls.restore = () => {
      throw new Error('crash-before-restore');
    };
    await expect(stopLive(l.deps, active)).rejects.toThrow('crash-before-restore');
    const newer = f.owners.claim({ ...f.claimInput, operationId: 'next' }).run;
    f.restartOwners();
    f.restartCoordinator();
    const older = f.owners.current(active.liveId)!;
    const latest = f.owners.current(newer.liveId)!;
    expect(older.generation).toBeLessThan(latest.generation);
    await expect(stopLive(lifecycle(f).deps, older)).rejects.toThrow('LIVE_GENERATION_STALE');
    expect(f.owners.current(newer.liveId)).toEqual(latest);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.start).not.toHaveBeenCalled();
  });
});

describe('actual Autopilot scheduler versus durable Live Start', () => {
  it('holds a continuation already due when Start acquires ownership, including repeated wakes', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    expect(f.store.find('relay')?.nextEvaluationAt).not.toBeNull();
    f.claim();
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 3; i += 1) {
      f.coordinator.evaluate('relay');
      f.coordinator.planStatusChanged('relay');
      f.coordinator.rootProcessCompleted('relay', 'process');
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(f.start).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.coordinator.supervisionStarted('relay')).toEqual({ code: 'LIVE_MODE_ACTIVE' });
    expect(f.coordinator.enable('relay')).toEqual({ code: 'LIVE_MODE_ACTIVE' });
  });
  it('continues to preserve explicit manual Off while background dispatch is held', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    f.claim();
    f.coordinator.disable('relay');
    await vi.advanceTimersByTimeAsync(5000);
    f.coordinator.supervisionStarted('relay');
    f.coordinator.restore('relay');
    f.coordinator.evaluate('relay');
    expect(f.store.find('relay')?.requestedEnabled).toBe(false);
    expect(f.store.find('relay')?.stopReason).toBe('manualDisabled');
    expect(f.start).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
  });
  it('holds all background dispatch after controller loss rather than treating an unreadable state as idle', async () => {
    const f = fixture();
    f.coordinator.enable('relay');
    f.owners.close();
    // Avoid closing this already-closed connection again in fixture teardown.
    const entry = fixtures.at(-1)!;
    entry.ownersClosed = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.coordinator.enable('relay')).toEqual({ code: 'LIVE_MODE_ACTIVE' });
  });
});
