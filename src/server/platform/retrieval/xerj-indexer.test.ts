/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalCapabilityPort } from '../../features/skills/application/ports.js';
import { XerjIndexer, xerjDefaultIgnores } from './xerj-indexer.js';

const instances: XerjIndexer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((indexer) => indexer.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(
  body = `console.error(JSON.stringify({event:'done',ok:true,files:6,records:12})); setInterval(() => {}, 1000);`,
) {
  const root = await mkdtemp(join(tmpdir(), 'xerj root '));
  roots.push(root);
  const manager = join(root, 'manager');
  await writeFile(
    manager,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ARGS_FILE, JSON.stringify({args:process.argv.slice(2),pid:process.pid}));\n${body}`,
    { mode: 0o700 },
  );
  const check = vi
    .fn<RetrievalCapabilityPort['check']>()
    .mockResolvedValue({ status: 'ready', manager, endpoint: 'http://127.0.0.1:19200' });
  const report = vi.fn();
  const create = (mode: 'auto' | 'manual' | 'off' = 'auto', selectedRoot = root) => {
    const indexer = new XerjIndexer(
      selectedRoot,
      mode,
      { check },
      {
        PATH: process.env.PATH,
        ARGS_FILE: join(root, 'args.json'),
        CODEX_HOME: join(root, '.home'),
      },
      report,
    );
    instances.push(indexer);
    return indexer;
  };
  return {
    root,
    check,
    create,
    report,
    args: async () => JSON.parse(await readFile(join(root, 'args.json'), 'utf8')),
  };
}

describe('host-owned XERJ indexing', () => {
  it('checks the committed fingerprint before launching and does not overwrite incompatible metadata', async () => {
    const f = await fixture();
    const first = f.create();
    first.start();
    await vi.waitFor(() => expect(first.status().state).toBe('watching'));
    await first.close();
    const path = join(
      f.root,
      '.home',
      'xerj-data',
      'autoindex',
      first.status().namespace!,
      '.gestalt-index-config.json',
    );
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.settings.root).toBe(f.root);
    saved.fingerprint = 'different';
    await writeFile(path, JSON.stringify(saved));
    await rm(join(f.root, 'args.json'));
    const restarted = f.create();
    restarted.start();
    await vi.waitFor(() =>
      expect(restarted.status()).toMatchObject({
        state: 'error',
        message: expect.stringContaining('fingerprint'),
      }),
    );
    await expect(f.args()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(path, 'utf8')).fingerprint).toBe('different');
  });

  it('explains native ambiguous repository assignment without exposing paths or output', async () => {
    const f = await fixture(
      `console.error(JSON.stringify({event:'warning',message:'new file private-path: refusing ambiguous assignment (use a new prefix)'})); setInterval(() => {},1000);`,
    );
    const indexer = f.create();
    indexer.start();
    await vi.waitFor(() =>
      expect(indexer.status()).toMatchObject({
        state: 'error',
        message: expect.stringContaining('index is stale'),
      }),
    );
    expect(indexer.status().message).not.toContain('private-path');
  });

  it('does nothing when disabled and starts only retrieval in manual mode', async () => {
    const f = await fixture();
    const disabled = f.create('off');
    disabled.start();
    expect(disabled.status().state).toBe('disabled');
    expect(f.check).not.toHaveBeenCalled();
    const manual = f.create('manual');
    manual.start();
    await vi.waitFor(() => expect(manual.status().state).toBe('ready'));
    await expect(readFile(join(f.root, '.xerjignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.args()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('indexes the canonical root once, reports native counts, reuses identity and reaps its owned child', async () => {
    const f = await fixture();
    const alias = `${f.root}-alias`;
    roots.push(alias);
    await symlink(f.root, alias);
    const first = f.create('auto', alias);
    first.start();
    first.start();
    await vi.waitFor(() =>
      expect(first.status()).toMatchObject({
        state: 'watching',
        root: f.root,
        files: 6,
        records: 12,
      }),
    );
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.check).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.root, start: true }));
    const { args, pid } = await f.args();
    expect(args.slice(0, 3)).toEqual(['xerj', 'autoindex', f.root]);
    for (const arg of ['--watch', '--no-graph', '--no-semantic', '--yes'])
      expect(args).toContain(arg);
    expect(args).not.toContain('--fresh');
    expect(args.slice(args.indexOf('--workers'), args.indexOf('--workers') + 2)).toEqual([
      '--workers',
      '2',
    ]);
    expect(await readFile(join(f.root, '.xerjignore'), 'utf8')).toBe(xerjDefaultIgnores);
    const namespace = first.status().namespace;
    await first.close();
    expect(() => process.kill(pid, 0)).toThrow();
    const second = f.create();
    second.start();
    await vi.waitFor(() => expect(second.status().state).toBe('watching'));
    expect(second.status().namespace).toBe(namespace);
  });

  it('preserves custom root exclusions and uses distinct namespaces for different roots', async () => {
    const a = await fixture();
    const b = await fixture();
    await writeFile(join(a.root, '.xerjignore'), 'custom-secret/\n!vendor/\n');
    const first = a.create();
    const second = b.create();
    first.start();
    second.start();
    await vi.waitFor(() => expect(first.status().state).toBe('watching'));
    await vi.waitFor(() => expect(second.status().state).toBe('watching'));
    expect(first.status().namespace).not.toBe(second.status().namespace);
    expect(await readFile(join(a.root, '.xerjignore'), 'utf8')).toBe('custom-secret/\n!vendor/\n');
    expect(xerjDefaultIgnores).toContain('!vendor/');
    for (const rule of [
      'node_modules/',
      'target/',
      'build/',
      'coverage/',
      '*.key',
      'credentials*',
      'secrets/',
    ])
      expect(xerjDefaultIgnores).toContain(rule);
  });

  it.each([
    ['absent', 'absent'],
    ['unavailable', 'error'],
  ] as const)('keeps optional backend %s nonfatal', async (status, state) => {
    const f = await fixture();
    f.check.mockResolvedValue(status === 'absent' ? { status } : { status, reason: 'test' });
    const indexer = f.create();
    indexer.start();
    await vi.waitFor(() => expect(indexer.status().state).toBe(state));
    await expect(f.args()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports another watcher without terminating it or the shared backend', async () => {
    const f = await fixture('process.exit(75);');
    const indexer = f.create();
    indexer.start();
    await vi.waitFor(() => expect(indexer.status().state).toBe('shared'));
    await indexer.close();
    expect(f.check).toHaveBeenCalledTimes(1);
    expect((await f.args()).args[1]).toBe('autoindex');
  });

  it('bounds malformed progress and keeps arbitrary diagnostics out of status and logs', async () => {
    const f = await fixture(
      `console.error('secret-value'); console.error('x'.repeat(20000)); console.error(JSON.stringify({event:'progress',phase:'index',pct:42,waiting_on:'private-path'})); setInterval(() => {},1000);`,
    );
    const indexer = f.create();
    indexer.start();
    await vi.waitFor(() =>
      expect(indexer.status()).toMatchObject({ state: 'indexing', phase: 'index', percent: 42 }),
    );
    expect(JSON.stringify(indexer.status())).not.toMatch(/secret-value|private-path/);
    expect(f.report).not.toHaveBeenCalled();
  });

  it('does not launch a watcher after shutdown races readiness', async () => {
    const f = await fixture();
    let release!: (value: Awaited<ReturnType<RetrievalCapabilityPort['check']>>) => void;
    f.check.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const indexer = f.create();
    indexer.start();
    await vi.waitFor(() => expect(f.check).toHaveBeenCalled());
    const closing = indexer.close();
    release({ status: 'absent' });
    await closing;
    expect(indexer.status().state).toBe('stopped');
    await expect(f.args()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
