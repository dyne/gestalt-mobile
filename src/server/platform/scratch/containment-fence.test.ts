/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimScratchContainment,
  containmentFenceName,
  withHistoryScratchContainment,
  withScratchContainment,
} from './containment-fence.js';
import { FilesystemSessionScratch, scratchMarkerName } from './filesystem-session-scratch.js';
import { FilesystemScratchCleanup } from './filesystem-scratch-cleanup.js';
import { CleanSessionScratch } from '../../features/sessions/clean-tmp/use-case.js';
import { startSession } from '../../features/sessions/start-session/use-case.js';
import { promoteRecentThread } from '../../features/sessions/promote-recent-thread/use-case.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';

const gates = vi.hoisted(() => ({
  opened: undefined as undefined | ((path: string) => Promise<void>),
  claimed: undefined as undefined | ((path: string) => void),
  released: undefined as undefined | ((path: string) => void),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      gates.claimed?.(String(args[0]));
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      try {
        await gates.opened?.(String(args[0]));
      } catch (error) {
        await handle.close();
        throw error;
      }
      return handle;
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      await actual.rmdir(...args);
      gates.released?.(String(args[0]));
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  gates.opened = undefined;
  gates.claimed = undefined;
  gates.released = undefined;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'containment-'));
  roots.push(root);
  const scratch = new FilesystemSessionScratch();
  const outer = await scratch.allocate({ id: 'outer-orphan', workspacePath: root });
  const selected = join(outer.directory, 'selected-workspace');
  await mkdir(selected);
  return { root, scratch, outer, selected };
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function barrier(entered: Promise<unknown>, operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      operation.then(() => {
        throw new Error('publication ended before barrier');
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('barrier timed out')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function cleanup(root: string, sessions: () => readonly { id: string; workspacePath: string }[]) {
  return new CleanSessionScratch({
    sessions,
    knownWorkspacePaths: async () => [root],
    storage: new FilesystemScratchCleanup(),
  }).execute();
}

describe('managed containment publication', () => {
  it('claims nested ancestors outermost first and releases in reverse without lifetime fences', async () => {
    const f = await fixture();
    const inner = await f.scratch.allocate({ id: 'inner', workspacePath: f.selected });
    const nested = join(inner.directory, 'nested');
    await mkdir(nested);
    const claims: string[] = [];
    const releases: string[] = [];
    gates.claimed = (path) => {
      if (path.endsWith(containmentFenceName)) claims.push(path);
    };
    gates.released = (path) => {
      if (path.endsWith(containmentFenceName)) releases.push(path);
    };
    await withScratchContainment(nested, async () => {
      expect(claims).toEqual([
        join(f.outer.directory, containmentFenceName),
        join(inner.directory, containmentFenceName),
      ]);
      expect((await lstat(claims[0]!)).mode & 0o777).toBe(0o700);
      await expect(lstat(join(f.outer.directory, '.controller-lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    expect(releases).toEqual([...claims].reverse());
  });

  it('allows nested publication under a live service without extending or releasing its lifetime fence', async () => {
    const f = await fixture();
    const service = await f.scratch.allocateService(f.root, 'fixture-service');
    const selected = join(service.directory, 'workspace');
    await mkdir(selected);
    try {
      const inner = await f.scratch.allocate({ id: 'service-client', workspacePath: selected });
      expect(await readFile(join(inner.directory, scratchMarkerName), 'utf8')).toContain(
        'service-client',
      );
      expect((await lstat(join(service.directory, '.controller-lock'))).isDirectory()).toBe(true);
      await expect(lstat(join(service.directory, containmentFenceName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await service.release();
    }
  });

  it('serializes new durable workspace publication before cleanup final authority reads', async () => {
    const f = await fixture();
    const entered = latch();
    const proceed = latch();
    const roster: RelaySessionSnapshot[] = [];
    const save = vi.fn();
    const publishing = startSession(
      { workspaceId: 'selected', profile: 'default', provider: 'codex' },
      {
        createId: () => 'new-selected',
        now: () => '2026-11-03T00:00:00.000Z',
        save,
        publish: (session) =>
          withScratchContainment(session.workspacePath, async () => {
            entered.release();
            await proceed.wait;
            roster.push(session);
          }),
        workspaces: {
          resolve: async () => ({ id: 'selected', name: 'selected', realPath: f.selected }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        skillProfiles: {
          readGlobalProfile: async () => undefined,
          readWorkspaceDefault: async () => undefined,
        },
        skillCatalog: () => ({ list: async () => ({ skills: [], errors: [] }) }),
      },
    );
    try {
      await barrier(entered.wait, publishing);
      expect((await cleanup(f.root, () => roster)).folders).toMatchObject({
        removed: 0,
        skipped: 1,
        reasons: { busy: 1 },
      });
      expect(roster).toEqual([]);
      expect(save).not.toHaveBeenCalled();
      proceed.release();
      await publishing;
      expect((await cleanup(f.root, () => roster)).folders).toMatchObject({
        removed: 0,
        skipped: 1,
        reasons: { protected: 1 },
      });
      expect((await lstat(f.selected)).isDirectory()).toBe(true);
    } finally {
      proceed.release();
      await Promise.allSettled([publishing]);
    }
  });

  it('does not publish promoted history through a held ancestor and permits a later retry', async () => {
    const f = await fixture();
    const roster: RelaySessionSnapshot[] = [];
    const read = vi.fn(async () => undefined);
    const save = vi.fn();
    const deps = {
      createId: () => 'history-import',
      now: () => '2026-11-03T00:00:00.000Z',
      list: () => roster,
      save,
      read,
      publish: (session: RelaySessionSnapshot) =>
        withHistoryScratchContainment(session.workspacePath, () => {
          roster.push(session);
        }),
    };
    const thread = { id: 'history-thread', cwd: f.selected, profile: 'default', recencyAt: 100 };
    const held = await claimScratchContainment(f.outer.directory, f.outer.ownerId);
    try {
      await expect(promoteRecentThread(thread, deps)).rejects.toThrow(
        'SESSION_SCRATCH_CONTAINMENT_BUSY',
      );
      expect(roster).toEqual([]);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }
    expect((await promoteRecentThread(thread, deps)).state).toBe('stopped');
    expect(roster).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await cleanup(f.root, () => roster)).folders.reasons.protected).toBe(1);
  });

  it('opens missing detached history below an ordinary system prefix without creating its cwd', async () => {
    const f = await fixture();
    const missing = join(parse(f.root).root, `gestalt-history-${basename(f.root)}`, 'nested');
    const publish = vi.fn(() => 'published');
    expect(await withHistoryScratchContainment(missing, publish)).toBe('published');
    expect(publish).toHaveBeenCalledOnce();
    await expect(lstat(dirname(missing))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fences every managed ancestor of missing history without relaxing allocation', async () => {
    const f = await fixture();
    const inner = await f.scratch.allocate({ id: 'inner', workspacePath: f.selected });
    const missing = join(inner.directory, 'missing', 'cwd');
    const claims: string[] = [];
    const releases: string[] = [];
    gates.claimed = (path) => {
      if (path.endsWith(containmentFenceName)) claims.push(path);
    };
    gates.released = (path) => {
      if (path.endsWith(containmentFenceName)) releases.push(path);
    };
    await withHistoryScratchContainment(missing, () => {
      expect(claims).toEqual([
        join(f.outer.directory, containmentFenceName),
        join(inner.directory, containmentFenceName),
      ]);
    });
    expect(releases).toEqual([...claims].reverse());
    await expect(lstat(join(inner.directory, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(withScratchContainment(missing, vi.fn())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(f.scratch.allocate({ id: 'new', workspacePath: missing })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    'missing-owner',
    'missing-intermediate-owner',
    'unmarked-owner',
    'retired-owner',
    'symlink',
    'dangling-link',
    'file',
    'invalid-marker',
    'invalid-lease',
  ] as const)(
    'rejects missing history through %s without publishing or creating paths',
    async (kind) => {
      const f = await fixture();
      let missing = join(f.selected, 'missing', 'cwd');
      if (
        kind === 'missing-owner' ||
        kind === 'missing-intermediate-owner' ||
        kind === 'unmarked-owner'
      ) {
        const base =
          kind === 'missing-intermediate-owner' ? join(f.outer.directory, 'absent') : f.selected;
        const owner = join(base, 'tmp', 'sessions', `mobile-${'0'.repeat(64)}`);
        if (kind === 'unmarked-owner') await mkdir(owner, { recursive: true, mode: 0o700 });
        missing = join(owner, 'missing');
      } else if (kind === 'retired-owner') {
        const retired = join(
          dirname(f.outer.directory),
          `.cleanup-${f.outer.ownerId}-00000000-0000-0000-0000-000000000001`,
        );
        await rename(f.outer.directory, retired);
        missing = join(retired, 'missing');
      } else if (kind === 'symlink' || kind === 'dangling-link') {
        const alias = join(f.root, 'alias');
        await symlink(kind === 'symlink' ? f.selected : join(f.root, 'absent'), alias);
        missing = join(alias, 'missing');
      } else if (kind === 'file') {
        const file = join(f.selected, 'file');
        await writeFile(file, 'persistent');
        missing = join(file, 'missing');
      } else if (kind === 'invalid-marker') {
        await writeFile(join(f.outer.directory, scratchMarkerName), '{}');
      } else {
        await mkdir(join(f.outer.directory, 'leases'), { mode: 0o700 });
        await writeFile(join(f.outer.directory, 'leases', 'unknown.json'), '{}', { mode: 0o600 });
      }
      const publish = vi.fn();
      await expect(withHistoryScratchContainment(missing, publish)).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
      await expect(lstat(missing)).rejects.toMatchObject({
        code: kind === 'file' ? 'ENOTDIR' : 'ENOENT',
      });
    },
  );

  it.each(['prefix', 'frontier-directory', 'frontier-link'] as const)(
    'revalidates a missing history %s changed while acquiring its ancestor fence',
    async (kind) => {
      const f = await fixture();
      const missing = join(f.selected, 'missing', 'cwd');
      gates.opened = async (path) => {
        if (path !== join(f.outer.directory, containmentFenceName)) return;
        gates.opened = undefined;
        if (kind === 'prefix') {
          await rename(f.selected, `${f.selected}-previous`);
          await mkdir(f.selected);
        } else if (kind === 'frontier-directory') {
          await mkdir(join(f.selected, 'missing'));
        } else {
          await symlink(f.root, join(f.selected, 'missing'));
        }
      };
      const publish = vi.fn();
      await expect(withHistoryScratchContainment(missing, publish)).rejects.toThrow(
        'SESSION_SCRATCH_CONTAINMENT_CHANGED',
      );
      expect(publish).not.toHaveBeenCalled();
      await expect(lstat(join(f.outer.directory, containmentFenceName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('retains a managed owner while missing-history publication is held and after its roster commit', async () => {
    const f = await fixture();
    const missing = join(f.selected, 'missing', 'cwd');
    const entered = latch();
    const proceed = latch();
    const roster: { id: string; workspacePath: string }[] = [];
    const publishing = withHistoryScratchContainment(missing, async () => {
      entered.release();
      await proceed.wait;
      roster.push({ id: 'history', workspacePath: missing });
    });
    try {
      await barrier(entered.wait, publishing);
      expect((await cleanup(f.root, () => roster)).folders).toMatchObject({
        removed: 0,
        reasons: { busy: 1 },
      });
      proceed.release();
      await publishing;
      expect((await cleanup(f.root, () => roster)).folders).toMatchObject({
        removed: 0,
        reasons: { protected: 1 },
      });
      await expect(lstat(join(f.selected, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      proceed.release();
      await Promise.allSettled([publishing]);
    }
  });

  it('blocks missing-history publication during cleanup and never recreates the retired owner', async () => {
    const f = await fixture();
    const missing = join(f.selected, 'missing', 'cwd');
    const entered = latch();
    const proceed = latch();
    gates.opened = async (path) => {
      if (path !== join(f.outer.directory, containmentFenceName)) return;
      gates.opened = undefined;
      entered.release();
      await proceed.wait;
    };
    const cleaning = cleanup(f.root, () => []);
    const publish = vi.fn();
    try {
      await barrier(entered.wait, cleaning);
      await expect(withHistoryScratchContainment(missing, publish)).rejects.toThrow(
        'SESSION_SCRATCH_CONTAINMENT_BUSY',
      );
      expect(publish).not.toHaveBeenCalled();
      proceed.release();
      expect((await cleaning).folders).toMatchObject({ removed: 1, failed: 0 });
      await expect(withHistoryScratchContainment(missing, publish)).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
      await expect(lstat(f.outer.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      proceed.release();
      await Promise.allSettled([cleaning]);
    }
  });

  it('revalidates the selected directory identity after fencing and preserves its replacement', async () => {
    const f = await fixture();
    const previous = `${f.selected}-previous`;
    await writeFile(join(f.selected, 'payload'), 'original');
    gates.opened = async (path) => {
      if (path !== join(f.outer.directory, containmentFenceName)) return;
      gates.opened = undefined;
      await rename(f.selected, previous);
      await mkdir(f.selected);
      await writeFile(join(f.selected, 'payload'), 'replacement');
    };
    const publish = vi.fn();
    await expect(withScratchContainment(f.selected, publish)).rejects.toThrow(
      'SESSION_SCRATCH_CONTAINMENT_CHANGED',
    );
    expect(publish).not.toHaveBeenCalled();
    expect(await readFile(join(previous, 'payload'), 'utf8')).toBe('original');
    expect(await readFile(join(f.selected, 'payload'), 'utf8')).toBe('replacement');
  });

  it('revalidates immutable ancestor provenance after locking without repairing changed metadata', async () => {
    const f = await fixture();
    const markerPath = join(f.outer.directory, scratchMarkerName);
    gates.opened = async (path) => {
      if (path !== join(f.outer.directory, containmentFenceName)) return;
      gates.opened = undefined;
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      await writeFile(
        markerPath,
        JSON.stringify({ ...marker, createdAt: '2026-11-03T01:00:00.000Z' }),
      );
    };
    const publish = vi.fn();
    await expect(withScratchContainment(f.selected, publish)).rejects.toThrow(
      'SESSION_SCRATCH_CONTAINMENT_CHANGED',
    );
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(markerPath, 'utf8')).createdAt).toBe(
      '2026-11-03T01:00:00.000Z',
    );
  });

  it('retains a replacement containment fence and releases only its own instance', async () => {
    const f = await fixture();
    const path = join(f.outer.directory, containmentFenceName);
    const previous = join(f.outer.directory, '.previous-containment');
    await expect(
      withScratchContainment(f.selected, async () => {
        await rename(path, previous);
        await mkdir(path, { mode: 0o700 });
      }),
    ).rejects.toThrow('SESSION_SCRATCH_CONTAINMENT_FENCE_CHANGED');
    expect((await lstat(path)).isDirectory()).toBe(true);
    expect((await lstat(previous)).isDirectory()).toBe(true);
  });

  it('rejects a fence replacement observed before publication while its original FD remains held', async () => {
    const f = await fixture();
    const path = join(f.outer.directory, containmentFenceName);
    const previous = join(f.outer.directory, '.previous-containment');
    gates.opened = async (opened) => {
      if (opened !== path) return;
      gates.opened = undefined;
      await rename(path, previous);
      await mkdir(path, { mode: 0o700 });
    };
    const publish = vi.fn();
    await expect(withScratchContainment(f.selected, publish)).rejects.toThrow(
      'SESSION_SCRATCH_CONTAINMENT_FENCE_CHANGED',
    );
    expect(publish).not.toHaveBeenCalled();
    expect((await lstat(path)).isDirectory()).toBe(true);
    expect((await lstat(previous)).isDirectory()).toBe(true);
  });

  it('never steals an unknown existing fence or expires it using process or age information', async () => {
    const f = await fixture();
    const path = join(f.outer.directory, containmentFenceName);
    await mkdir(path, { mode: 0o700 });
    const identity = await lstat(path, { bigint: true });
    await expect(f.scratch.allocate({ id: 'inner', workspacePath: f.selected })).rejects.toThrow(
      'SESSION_SCRATCH_CONTAINMENT_BUSY',
    );
    const current = await lstat(path, { bigint: true });
    expect([current.dev, current.ino, current.birthtimeNs]).toEqual([
      identity.dev,
      identity.ino,
      identity.birthtimeNs,
    ]);
    expect((await cleanup(f.root, () => [])).folders.reasons.busy).toBe(1);
  });

  it('keeps ordinary nested selections valid and rejects linked selections without fallback', async () => {
    const f = await fixture();
    const ordinary = join(f.root, 'ordinary', 'nested');
    await mkdir(ordinary, { recursive: true });
    const publish = vi.fn();
    await withScratchContainment(`${ordinary}/.`, publish);
    expect(publish).toHaveBeenCalledTimes(1);
    const alias = join(f.root, 'linked');
    await symlink(ordinary, alias);
    await expect(withScratchContainment(alias, publish)).rejects.toThrow(
      'SESSION_SCRATCH_UNSAFE_PATH',
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
