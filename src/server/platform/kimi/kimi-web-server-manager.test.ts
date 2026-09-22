/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KimiWebServerManager } from './kimi-web-server-manager.js';
import type { SkillSelection } from '../../features/skills/model/skill-profile.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-manager-'));
  roots.push(root);
  return root;
}

type FakeChild = {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: string, listener: (...args: unknown[]) => void): FakeChild;
  on(event: string, listener: (...args: unknown[]) => void): FakeChild;
  off(event: string, listener: (...args: unknown[]) => void): FakeChild;
  emit(event: string, ...args: unknown[]): boolean;
  kill(signal?: NodeJS.Signals): boolean;
};

function fakeChild(banner = 'Token: test-token-123\n'): FakeChild {
  const events = new EventEmitter();
  const child: FakeChild = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null,
    once: (event, listener) => {
      events.once(event, listener as () => void);
      return child;
    },
    on: (event, listener) => {
      events.on(event, listener as () => void);
      return child;
    },
    off: (event, listener) => {
      events.off(event, listener as () => void);
      return child;
    },
    emit: (event, ...args) => events.emit(event, ...args),
    kill: () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        events.emit('exit', 0, null);
      });
      return true;
    },
  };
  queueMicrotask(() => child.stdout.emit('data', Buffer.from(banner)));
  return child;
}

function stubFetch(configPosts: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/api/v1/meta')) {
        return Response.json({ code: 0, msg: 'success', data: {}, request_id: 'r' });
      }
      if (target.endsWith('/api/v1/config')) {
        configPosts.push(JSON.parse(String(init?.body ?? '{}')) as never);
        return Response.json({ code: 0, msg: 'success', data: {}, request_id: 'r' });
      }
      return Response.json({ code: 40401, msg: 'not found', data: null, request_id: 'r' });
    }),
  );
}

async function fixture(root: string): Promise<{ stateBase: string; sourceShareDir: string }> {
  const sourceShareDir = join(root, 'kimi-home');
  await mkdir(join(sourceShareDir, 'credentials'), { recursive: true });
  await writeFile(join(sourceShareDir, 'config.toml'), 'default_model = "kimi-k3"\n');
  return { stateBase: join(root, 'state'), sourceShareDir };
}

const selection = (enabled: boolean): SkillSelection => [
  { name: 'deploy', path: '/skills/deploy', enabled },
];

describe('KimiWebServerManager', () => {
  it('spawns one kimi web per profile, publishes the materialized skills dir, and reuses it', async () => {
    const root = await sandbox();
    const { stateBase, sourceShareDir } = await fixture(root);
    const configPosts: unknown[] = [];
    stubFetch(configPosts);
    const spawns: string[][] = [];
    const children: FakeChild[] = [];
    const manager = new KimiWebServerManager({
      stateBase,
      sourceShareDir,
      spawnImpl: (_command, args) => {
        spawns.push(args);
        const child = fakeChild();
        children.push(child);
        return child as never;
      },
    });

    const first = await manager.ensure('default', selection(true));
    expect(first.token).toBe('test-token-123');
    expect(first.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual(['web', '--no-open', '--port', expect.stringMatching(/^\d+$/)]);
    expect(configPosts).toEqual([{ extra_skill_dirs: [first.skillsDir] }]);

    const second = await manager.ensure('default', selection(true));
    expect(second).toBe(first);
    expect(spawns).toHaveLength(1);

    await manager.stopAll();
    expect(children[0].exitCode).toBe(0);
  });

  it('restarts the profile server when the skill selection fingerprint changes', async () => {
    const root = await sandbox();
    const { stateBase, sourceShareDir } = await fixture(root);
    const configPosts: unknown[] = [];
    stubFetch(configPosts);
    const spawns: string[][] = [];
    const manager = new KimiWebServerManager({
      stateBase,
      sourceShareDir,
      spawnImpl: (_command, args) => {
        spawns.push(args);
        return fakeChild() as never;
      },
    });

    await manager.ensure('default', selection(true));
    const afterChange = await manager.ensure('default', selection(false));
    expect(spawns).toHaveLength(2);
    expect(configPosts).toHaveLength(2);
    expect(afterChange.shareDir).toContain(join('state', 'default'));
  });

  it('surfaces an early child exit with the log tail and forgets the server', async () => {
    const root = await sandbox();
    const { stateBase, sourceShareDir } = await fixture(root);
    stubFetch([]);
    const manager = new KimiWebServerManager({
      stateBase,
      sourceShareDir,
      spawnImpl: () => {
        const child = fakeChild('');
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('fatal: something broke\n'));
          child.emit('exit', 1, null);
        });
        return child as never;
      },
    });
    await expect(manager.ensure('default', selection(true))).rejects.toThrow(
      /exited before becoming ready/,
    );
    expect(manager.get('default')).toBeNull();
  });

  it('keeps profile servers isolated from each other', async () => {
    const root = await sandbox();
    const { stateBase, sourceShareDir } = await fixture(root);
    const configPosts: unknown[] = [];
    stubFetch(configPosts);
    const manager = new KimiWebServerManager({
      stateBase,
      sourceShareDir,
      spawnImpl: () => fakeChild() as never,
    });
    const a = await manager.ensure('default', selection(true));
    const b = await manager.ensure('work', selection(true));
    expect(a.shareDir).not.toBe(b.shareDir);
    expect(a.skillsDir).not.toBe(b.skillsDir);
    await manager.stopAll();
  });
});
