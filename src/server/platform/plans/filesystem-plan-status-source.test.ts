/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlanStatusLease, PlanStatusUpdate } from '../../features/plans/application/ports.js';
import { SupervisedPlanRegistry } from '../../features/plans/application/supervised-plan-registry.js';
import {
  FilesystemPlanStatusSource,
  planStatusDirectoryPath,
  planStatusFilePath,
} from './filesystem-plan-status-source.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function org(title: string): string {
  return `#+TITLE: ${title}
* WIP [#A] Observe status
:PROPERTIES:
:ID: observe-status
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Observe a private signal.
- Notes :: Keep sessions isolated.
`;
}

function signal(planPath: string, reason = 'signal'): string {
  return JSON.stringify({
    schemaVersion: 1,
    planPath,
    reason,
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
}

function leaseStatusPath(lease: PlanStatusLease, planPath: string): string {
  return planStatusFilePath(lease.statusDirectory, planPath);
}

describe('FilesystemPlanStatusSource', () => {
  it.each(['supervision-start', 'resync'])('retains the %s helper signal reason', async (reason) => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const workspace = join(root, 'workspace');
    const planPath = join(workspace, 'plan.org');
    await mkdir(workspace);
    await writeFile(planPath, org('Signal vocabulary'));
    const updates: PlanStatusUpdate[] = [];
    const source = new FilesystemPlanStatusSource(join(root, 'state'));
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) => updates.push(update));
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath, reason));
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ kind: 'updated', reason }));
    lease.close();
  });

  it('rejects an unknown helper signal reason without rejecting the plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const workspace = join(root, 'workspace');
    const planPath = join(workspace, 'plan.org');
    await mkdir(workspace);
    await writeFile(planPath, org('Unknown signal'));
    const updates: PlanStatusUpdate[] = [];
    const source = new FilesystemPlanStatusSource(join(root, 'state'));
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) => updates.push(update));
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath, 'unknown'));
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ kind: 'updated', reason: null }));
    lease.close();
  });

  it('isolates two session-private signals and refreshes an atomic replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state', 'plans');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
    const planA = join(workspaceA, 'plan.org');
    const planB = join(workspaceB, 'plan.org');
    await Promise.all([writeFile(planA, org('Plan A')), writeFile(planB, org('Plan B'))]);

    const source = new FilesystemPlanStatusSource(stateDirectory);
    const updatesA: PlanStatusUpdate[] = [];
    const updatesB: PlanStatusUpdate[] = [];
    const statusDirectoryA = planStatusDirectoryPath(workspaceA, 'session-a');
    await mkdir(statusDirectoryA, { recursive: true });
    await writeFile(planStatusFilePath(statusDirectoryA, planA), signal(planA), {
      mode: 0o600,
    });

    const leaseA = await source.open({ id: 'session-a', workspacePath: workspaceA }, (update) =>
      updatesA.push(update),
    );
    const leaseB = await source.open({ id: 'session-b', workspacePath: workspaceB }, (update) =>
      updatesB.push(update),
    );
    expect(leaseA.statusDirectory).toBe(statusDirectoryA);
    expect(leaseB.statusDirectory).toBe(planStatusDirectoryPath(workspaceB, 'session-b'));
    expect(updatesA).toMatchObject([{ kind: 'updated', plan: { title: 'Plan A' } }]);
    expect(updatesB).toEqual([]);
    expect(leaseA.statusDirectory).not.toContain('session-a');
    expect(leaseB.statusDirectory).not.toBe(leaseA.statusDirectory);

    await writeFile(planA, org('Plan A refreshed'));
    const statusPathA = leaseStatusPath(leaseA, planA);
    const replacement = `${statusPathA}.next`;
    await writeFile(replacement, signal(planA), { mode: 0o600 });
    await rename(replacement, statusPathA);
    await vi.waitFor(() =>
      expect(updatesA.at(-1)).toMatchObject({
        kind: 'updated',
        plan: { title: 'Plan A refreshed' },
      }),
    );
    expect(updatesB).toHaveLength(0);

    if (process.platform !== 'win32') expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    leaseA.close();
    leaseB.close();
  });

  it('keeps the last valid update when a status signal or plan is transiently invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Valid plan'));
    const source = new FilesystemPlanStatusSource(stateDirectory);
    const updates: PlanStatusUpdate[] = [];
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      updates.push(update),
    );
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath), { mode: 0o600 });
    await vi.waitFor(() =>
      expect(updates.at(-1)).toMatchObject({ kind: 'updated', plan: { title: 'Valid plan' } }),
    );
    await writeFile(leaseStatusPath(lease, planPath), '{not json', { mode: 0o600 });
    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' }),
    );
    expect(
      updates.some((update) => update.kind === 'updated' && update.plan.title === 'Valid plan'),
    ).toBe(true);
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath), { mode: 0o600 });
    await vi.waitFor(() =>
      expect(updates.at(-1)).toMatchObject({ kind: 'updated', plan: { title: 'Valid plan' } }),
    );
    await rm(planPath);
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath), { mode: 0o600 });
    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' }),
    );
    await lease.remove();
    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' }),
    );
    await expect(lease.remove()).resolves.toBeUndefined();
    lease.close();
  });

  it('coalesces a burst of atomic replacements into one replacement update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Before burst'));
    const updates: PlanStatusUpdate[] = [];
    const source = new FilesystemPlanStatusSource(stateDirectory);
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      updates.push(update),
    );
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() =>
      expect(updates.at(-1)).toMatchObject({ kind: 'updated', plan: { title: 'Before burst' } }),
    );
    const beforeBurst = updates.length;
    await writeFile(planPath, org('After burst'));
    for (let replacement = 0; replacement < 3; replacement += 1) {
      const statusPath = leaseStatusPath(lease, planPath);
      const next = `${statusPath}.${replacement}`;
      await writeFile(next, signal(planPath));
      await rename(next, statusPath);
    }
    await vi.waitFor(() =>
      expect(updates.at(-1)).toMatchObject({ kind: 'updated', plan: { title: 'After burst' } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(updates.slice(beforeBurst)).toEqual([
      expect.objectContaining({ kind: 'updated', plan: expect.objectContaining({ title: 'After burst' }) }),
    ]);
    lease.close();
  });

  it('reports malformed Org as bounded unavailable while a registry retains its last good plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Last good plan'));
    const registry = new SupervisedPlanRegistry();
    const updates: PlanStatusUpdate[] = [];
    const source = new FilesystemPlanStatusSource(stateDirectory);
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) => {
      updates.push(update);
      registry.accept('session-a', update);
    });
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() =>
      expect(registry.find('session-a')).toMatchObject({ title: 'Last good plan' }),
    );
    await writeFile(planPath, '#+TITLE: malformed\n* WIP [#A] Missing properties\n');
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' }),
    );
    expect(registry.find('session-a')).toMatchObject({ title: 'Last good plan' });
    lease.close();
  });

  it('rejects a lexically in-workspace symlink to an outside plan before reading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(join(outside, 'outside.org'), org('Outside plan must not be exposed'));
    await symlink(outside, join(workspace, 'link'));
    const updates: PlanStatusUpdate[] = [];
    const source = new FilesystemPlanStatusSource(stateDirectory);
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      updates.push(update),
    );
    await writeFile(
      leaseStatusPath(lease, join(workspace, 'link', 'outside.org')),
      signal(join(workspace, 'link', 'outside.org')),
    );
    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' }),
    );
    expect(updates).not.toContainEqual(
      expect.objectContaining({ kind: 'updated', plan: expect.objectContaining({ title: 'Outside plan must not be exposed' }) }),
    );
    lease.close();
  });

  it('persists a dismissed plan identity across restart while admitting a different plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const firstPlan = join(workspace, 'first.org');
    const secondPlan = join(workspace, 'second.org');
    await Promise.all([writeFile(firstPlan, org('Dismissed plan')), writeFile(secondPlan, org('Next plan'))]);
    let identity: string | undefined;
    const source = new FilesystemPlanStatusSource(stateDirectory);
    const firstLease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) => {
      if (update.kind === 'updated') identity = update.identity;
    });
    await writeFile(leaseStatusPath(firstLease, firstPlan), signal(firstPlan));
    await vi.waitFor(() => expect(identity).toBeTypeOf('string'));
    await source.remove('session-a', identity);
    source.closeAll();

    await writeFile(
      planStatusFilePath(planStatusDirectoryPath(workspace, 'session-a'), firstPlan),
      signal(firstPlan),
    );
    const resumedUpdates: PlanStatusUpdate[] = [];
    const resumed = new FilesystemPlanStatusSource(stateDirectory);
    const resumedLease = await resumed.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      resumedUpdates.push(update),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(resumedUpdates).toEqual([]);
    await writeFile(leaseStatusPath(resumedLease, secondPlan), signal(secondPlan));
    await vi.waitFor(() =>
      expect(resumedUpdates.at(-1)).toMatchObject({ kind: 'updated', plan: { title: 'Next plan' } }),
    );
    resumed.closeAll();
  });

  it('does not advance a dismissal cache when its atomic candidate write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Still active after failed close'));
    const updates: PlanStatusUpdate[] = [];
    const registry = new SupervisedPlanRegistry();
    const source = new FilesystemPlanStatusSource(stateDirectory, {
      writeFile: async () => {
        throw new Error('candidate write failed');
      },
      rename,
    });
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) => {
      updates.push(update);
      registry.accept('session-a', update);
    });
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(updates.at(-1)?.kind).toBe('updated'));
    const identity = (updates.at(-1) as Extract<PlanStatusUpdate, { kind: 'updated' }>).identity;
    await expect(source.remove('session-a', identity)).rejects.toThrow('candidate write failed');
    expect(registry.find('session-a')).toMatchObject({ title: 'Still active after failed close' });
    const updatesBeforeRetry = updates.length;
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(updatesBeforeRetry));
    expect(updates.at(-1)).toMatchObject({ kind: 'updated', plan: { title: 'Still active after failed close' } });
    lease.close();
  });

  it('does not advance a dismissal cache when atomic replacement fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Still active after failed replacement'));
    const updates: PlanStatusUpdate[] = [];
    const source = new FilesystemPlanStatusSource(stateDirectory, {
      writeFile,
      rename: async () => {
        throw new Error('atomic replacement failed');
      },
    });
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      updates.push(update),
    );
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(updates.at(-1)?.kind).toBe('updated'));
    const identity = (updates.at(-1) as Extract<PlanStatusUpdate, { kind: 'updated' }>).identity;
    await expect(source.remove('session-a', identity)).rejects.toThrow('atomic replacement failed');
    const updatesBeforeRetry = updates.length;
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(updatesBeforeRetry));
    lease.close();
  });

  it('does not dismiss a plan when status unlink fails, including after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Still active after unlink failure'));
    const updates: PlanStatusUpdate[] = [];
    const registry = new SupervisedPlanRegistry();
    const source = new FilesystemPlanStatusSource(stateDirectory, undefined, undefined, {
      rm: async () => {
        throw new Error('status unlink failed');
      },
    });
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) => {
      updates.push(update);
      registry.accept('session-a', update);
    });
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(updates.at(-1)?.kind).toBe('updated'));
    const identity = (updates.at(-1) as Extract<PlanStatusUpdate, { kind: 'updated' }>).identity;
    await expect(source.remove('session-a', identity)).rejects.toThrow('status unlink failed');
    expect(registry.find('session-a')).toMatchObject({ title: 'Still active after unlink failure' });
    const updatesBeforeRetry = updates.length;
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(updatesBeforeRetry));
    source.closeAll();

    const restartedUpdates: PlanStatusUpdate[] = [];
    const restarted = new FilesystemPlanStatusSource(stateDirectory);
    const restartedLease = await restarted.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      restartedUpdates.push(update),
    );
    expect(restartedUpdates.at(-1)).toMatchObject({
      kind: 'updated',
      plan: { title: 'Still active after unlink failure' },
    });
    restartedLease.close();
  });

  it('treats a malformed persisted dismissal as unavailable instead of forgetting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(stateDirectory), mkdir(workspace)]);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Must not be exposed through malformed dismissal state'));
    const sessionId = 'session-a';
    await mkdir(planStatusDirectoryPath(workspace, sessionId), { recursive: true });
    await writeFile(
      planStatusFilePath(planStatusDirectoryPath(workspace, sessionId), planPath),
      signal(planPath),
    );
    await writeFile(
      join(stateDirectory, `${createHash('sha256').update(sessionId).digest('hex')}.dismissals.json`),
      '{interrupted',
    );
    const updates: PlanStatusUpdate[] = [];
    const source = new FilesystemPlanStatusSource(stateDirectory);
    const lease = await source.open({ id: sessionId, workspacePath: workspace }, (update) =>
      updates.push(update),
    );
    expect(updates).toEqual([{ kind: 'unavailable', code: 'PLAN_STATUS_UNAVAILABLE' }]);
    expect(updates).not.toContainEqual(expect.objectContaining({ kind: 'updated' }));
    lease.close();
  });

  it('does not deliver an in-flight dismissed refresh after its final read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Racing plan'));
    let releaseRead: (() => void) | undefined;
    let delayPlanRead = false;
    const source = new FilesystemPlanStatusSource(
      stateDirectory,
      undefined,
      {
        readFile: (async (path, options) => {
          if (delayPlanRead && path === planPath)
            await new Promise<void>((resolve) => (releaseRead = resolve));
          return readFile(path, options as never);
        }) as typeof readFile,
        realpath: (async (path) => String(path)) as typeof import('node:fs/promises').realpath,
      },
    );
    const updates: PlanStatusUpdate[] = [];
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      updates.push(update),
    );
    delayPlanRead = true;
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    await source.remove('session-a', createHash('sha256').update(planPath).digest('hex'));
    releaseRead?.();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(updates).not.toContainEqual(expect.objectContaining({ kind: 'updated' }));
    expect(updates).toEqual([]);
    lease.close();
  });

  it('does not deliver a valid refresh after its lease closes while the Org read is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-status-'));
    temporaryPaths.push(root);
    const stateDirectory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const planPath = join(workspace, 'plan.org');
    await writeFile(planPath, org('Stale closed lease plan'));
    let releaseRead: (() => void) | undefined;
    let delayPlanRead = false;
    const source = new FilesystemPlanStatusSource(
      stateDirectory,
      undefined,
      {
        readFile: (async (path, options) => {
          if (delayPlanRead && path === planPath)
            await new Promise<void>((resolve) => (releaseRead = resolve));
          return readFile(path, options as never);
        }) as typeof readFile,
        realpath: (async (path) => String(path)) as typeof import('node:fs/promises').realpath,
      },
    );
    const updates: PlanStatusUpdate[] = [];
    const lease = await source.open({ id: 'session-a', workspacePath: workspace }, (update) =>
      updates.push(update),
    );
    delayPlanRead = true;
    await writeFile(leaseStatusPath(lease, planPath), signal(planPath));
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    lease.close();
    releaseRead?.();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(updates).not.toContainEqual(
      expect.objectContaining({ kind: 'updated', plan: expect.objectContaining({ title: 'Stale closed lease plan' }) }),
    );
  });
});
