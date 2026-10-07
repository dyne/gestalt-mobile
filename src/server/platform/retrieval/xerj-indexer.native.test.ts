/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { ManagedXerj } from './managed-xerj.js';
import { XerjIndexer } from './xerj-indexer.js';
import { xerjContentArguments } from './xerj-index-config.js';

// Explicit opt-in: no downloads, no ordinary unit-test dependency on XERJ.
it.skipIf(!process.env.XERJ_NATIVE_HOME)(
  'native root watcher preserves forks, exclusions, updates, deletions and restart state, and reports ambiguous additions',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt xerj native '));
    const root = join(directory, 'source');
    const manager = resolve('../gestalt/public/gestalt');
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address() as { port: number };
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const environment = {
      ...process.env,
      GESTALT_HOME: process.env.XERJ_NATIVE_HOME,
      CODEX_HOME: join(directory, 'home'),
      GESTALT_MANAGER_BIN: manager,
      XERJ_URL: `http://127.0.0.1:${address.port}`,
      XERJ_READY_TIMEOUT_MS: '15000',
    };
    const instances: XerjIndexer[] = [];
    const create = () => {
      const instance = new XerjIndexer(root, 'auto', new ManagedXerj(environment), environment);
      instances.push(instance);
      instance.start();
      return instance;
    };
    const run = promisify(execFile);
    try {
      for (const repo of ['bitcoin-core', 'bitcoin-knots', 'bitcoin-roots']) {
        await mkdir(join(root, repo), { recursive: true });
        await run('git', ['init', '--quiet', join(root, repo)]);
        await writeFile(
          join(root, repo, 'shared.ts'),
          'export function sharedFork() { return "same implementation"; }\n',
        );
        await writeFile(join(root, repo, 'unique.ts'), `export const repository = "${repo}";\n`);
      }
      for (const tree of [
        'node_modules',
        'target',
        'build',
        'dist',
        'coverage',
        '__pycache__',
        '.cache',
        '.next',
        '.astro',
        '.git',
        '.codex',
        'secrets',
        'vendor',
      ]) {
        await mkdir(join(root, tree), { recursive: true });
        await writeFile(join(root, tree, 'fixture.ts'), `export const directory = "${tree}";\n`);
      }
      await writeFile(join(root, 'credentials.json'), '{"fixture":"not-a-real-secret"}');
      await writeFile(join(root, 'bitcoin-core', '.gitignore'), 'ignored.ts\n');
      await writeFile(join(root, 'bitcoin-core', 'ignored.ts'), 'export const ignored = true;');
      const first = create();
      await vi.waitFor(() => expect(first.status().state).toBe('watching'), {
        timeout: 45000,
        interval: 100,
      });
      const namespace = first.status().namespace!;
      const key = (
        await readFile(join(environment.CODEX_HOME, 'xerj-data/admin.key'), 'utf8')
      ).trim();
      const search = async () => {
        const response = await fetch(`${environment.XERJ_URL}/${namespace}-*/_search`, {
          method: 'POST',
          headers: { Authorization: `ApiKey ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ size: 100, query: { match_all: {} } }),
        });
        expect(response.ok).toBe(true);
        const result = (await response.json()) as {
          hits: { hits: Array<{ _id: string; _source: { ax_paths?: string[] } }> };
        };
        return result.hits.hits;
      };
      const initial = await search();
      const paths = new Set(initial.flatMap((hit) => hit._source.ax_paths ?? []));
      expect([...paths].sort()).toEqual([
        'bitcoin-core/shared.ts',
        'bitcoin-core/unique.ts',
        'bitcoin-knots/shared.ts',
        'bitcoin-knots/unique.ts',
        'bitcoin-roots/shared.ts',
        'bitcoin-roots/unique.ts',
        'vendor/fixture.ts',
      ]);
      expect(initial.some((hit) => hit._source.ax_paths?.length === 3)).toBe(true);
      const shared = create();
      await vi.waitFor(() => expect(shared.status().state).toBe('shared'), { timeout: 15000 });
      await shared.close();
      expect(first.status().state).toBe('watching');
      const updatedAt = first.status().lastUpdate;
      await writeFile(
        join(root, 'bitcoin-core', 'unique.ts'),
        'export const repository = "bitcoin-core-updated";',
      );
      await rm(join(root, 'bitcoin-knots', 'unique.ts'));
      await vi.waitFor(
        () => {
          expect(first.status().state).toBe('watching');
          expect(first.status().lastUpdate).not.toBe(updatedAt);
        },
        { timeout: 45000, interval: 100 },
      );
      const updated = await search();
      const updatedPaths = updated.flatMap((hit) => hit._source.ax_paths ?? []);
      expect(updatedPaths).toContain('bitcoin-core/unique.ts');
      expect(updatedPaths).not.toContain('bitcoin-knots/unique.ts');
      const ids = updated.map((hit) => hit._id).sort();
      await first.close();
      const restarted = create();
      await vi.waitFor(() => expect(restarted.status().state).toBe('watching'), {
        timeout: 30000,
        interval: 100,
      });
      expect(restarted.status().namespace).toBe(namespace);
      expect((await search()).map((hit) => hit._id).sort()).toEqual(ids);
      // A same-repository addition is distinct from creating a new repository.
      // rc.87 drops repository scope when classifying either new path.
      await writeFile(join(root, 'bitcoin-core', 'adjacent.ts'), 'export const adjacent = true;');
      await vi.waitFor(
        () =>
          expect(restarted.status()).toMatchObject({
            state: 'error',
            message: expect.stringContaining('index is stale'),
          }),
        { timeout: 30000, interval: 100 },
      );
      await rm(join(root, 'bitcoin-core', 'adjacent.ts'));
      await vi.waitFor(() => expect(restarted.status().state).toBe('watching'), {
        timeout: 30000,
        interval: 100,
      });
      await mkdir(join(root, 'new-workspace', '.git'), { recursive: true });
      await writeFile(
        join(root, 'new-workspace', 'added.ts'),
        'export const newlyAddedRepository = true;',
      );
      await vi.waitFor(
        () =>
          expect(restarted.status()).toMatchObject({
            state: 'error',
            message: expect.stringContaining('index is stale'),
          }),
        { timeout: 30000, interval: 100 },
      );
      await restarted.close();
      await rm(join(root, 'new-workspace'), { recursive: true });
      const direct = (folder: string, extra: string[] = []) =>
        run(
          manager,
          [
            'xerj',
            'autoindex',
            folder,
            '--url',
            environment.XERJ_URL,
            ...xerjContentArguments,
            '--workers',
            '2',
            '--pdf-workers',
            '1',
            '--bulk-mb',
            '4',
            '--yes',
            '--progress',
            'json',
            ...extra,
          ],
          { cwd: folder, env: environment, timeout: 30000, maxBuffer: 1024 * 1024 },
        );
      await direct(root);
      await writeFile(join(root, 'bitcoin-core', 'adjacent.ts'), 'export const adjacent = true;');
      await expect(direct(root)).rejects.toMatchObject({
        stderr: expect.stringContaining('refusing ambiguous assignment'),
      });
      // --dataset is a map filter; it cannot select an indexing destination.
      await expect(direct(root, ['--dataset', 'bitcoin-core-docs'])).rejects.toMatchObject({
        stderr: expect.stringContaining('refusing ambiguous assignment'),
      });
      await rm(join(root, 'bitcoin-core', 'adjacent.ts'));

      // Control: one repository/dataset accepts new files beside existing ones
      // and in a new subdirectory. The defect is cross-dataset scope loss.
      const single = join(directory, 'single-repository');
      await mkdir(join(single, 'src'), { recursive: true });
      await run('git', ['init', '--quiet', single]);
      await writeFile(join(single, 'src', 'existing.ts'), 'export const existing = true;');
      await direct(single);
      await writeFile(join(single, 'src', 'added.ts'), 'export const added = true;');
      await mkdir(join(single, 'src', 'nested'));
      await writeFile(join(single, 'src', 'nested', 'added.ts'), 'export const nested = true;');
      const addition = await direct(single);
      expect(addition.stderr).toContain('"ok":true');
      expect(addition.stderr).toContain('"generation":2');
      await expect(
        readFile(join(root, 'bitcoin-core', '.codex/config.toml')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all(instances.map((instance) => instance.close()));
      await run(manager, ['xerj', 'stop'], { cwd: root, env: environment, timeout: 20000 }).catch(
        () => {},
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
