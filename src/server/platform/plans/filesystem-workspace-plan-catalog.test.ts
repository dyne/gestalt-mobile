/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilesystemWorkspacePlanCatalog } from './filesystem-workspace-plan-catalog.js';
import { OrgPlanDiscovery } from './org-plan-discovery.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gestalt-workspace-plans-'));
  roots.push(root);
  return root;
}

function plan(title: string): string {
  return `#+TITLE: ${title}
#+SUBTITLE: Catalog test
#+DATE: 2026-08-05
#+KEYWORDS: catalog

* TODO [#A] First task
:PROPERTIES:
:ID: first-task
:SKILLS: $gestalt:development-testing
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Read a local plan.
- Notes :: Do not mutate sessions.
`;
}

describe('FilesystemWorkspacePlanCatalog', () => {
  it('reads execution admission through the canonical reader and preserves parser reasons', async () => {
    const root = await workspace();
    await mkdir(join(root, '.gestalt'));
    const filename = join(root, '.gestalt', 'plan.org');
    await writeFile(filename, plan('Admission'));
    const catalog = new FilesystemWorkspacePlanCatalog();
    const result = await catalog.readExecution(root, '.gestalt/plan.org');
    expect(result).toMatchObject({
      kind: 'available',
      canonicalPath: await filesystem.realpath(filename),
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      plan: { title: 'Admission' },
    });
    expect(await catalog.readExecution(root, '.gestalt/plan.org')).toEqual(result);
    await writeFile(filename, plan('Admission').replace(':ID: first-task', ':ID:'));
    expect(await catalog.readExecution(root, '.gestalt/plan.org')).toEqual({
      kind: 'invalid',
      reason: 'MISSING_REQUIRED_FIELD',
    });
    await writeFile(filename, '#+TITLE: Notes\n* Notes');
    expect(await catalog.readExecution(root, '.gestalt/plan.org')).toEqual({
      kind: 'invalid',
      reason: 'MALFORMED_ORG',
    });
  });

  it('keeps missing, unreadable, oversized, traversal and symlink execution reads unavailable', async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, '.gestalt'));
    await writeFile(join(outside, 'plan.org'), plan('Outside'));
    await symlink(outside, join(root, 'linked'));
    await symlink(join(outside, 'plan.org'), join(root, '.gestalt', 'linked.org'));
    await writeFile(join(root, '.gestalt', 'oversized.org'), 'x'.repeat(1_048_577));
    const catalog = new FilesystemWorkspacePlanCatalog();
    for (const name of ['../plan.org', '/plan.org', 'a/../plan.org', 'missing.org']) {
      expect(await catalog.readExecution(root, name)).toEqual({ kind: 'missing' });
    }
    for (const name of ['linked/plan.org', '.gestalt/linked.org', '.gestalt/oversized.org']) {
      expect(await catalog.readExecution(root, name)).toEqual({ kind: 'unavailable' });
    }
    await writeFile(join(root, '.gestalt', 'denied.org'), plan('Denied'));
    const denied = new FilesystemWorkspacePlanCatalog({
      ...filesystem,
      readFile: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    expect(await denied.readExecution(root, '.gestalt/denied.org')).toEqual({
      kind: 'unavailable',
    });
  });

  it('shares concurrent discovery and reuses unchanged entries while detecting edits, additions and deletions', async () => {
    const root = await workspace();
    await mkdir(join(root, '.gestalt'));
    await writeFile(join(root, '.gestalt', 'first.org'), plan('First'));
    await writeFile(join(root, '.gestalt', 'second.org'), plan('Second'));
    let now = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nativeDiscovery = new OrgPlanDiscovery();
    const discovery = {
      list: vi.fn(async (path: string) => {
        await gate;
        return nativeDiscovery.list(path);
      }),
    };
    const readFile = vi.fn((path: string, encoding: 'utf8') => filesystem.readFile(path, encoding));
    const catalog = new FilesystemWorkspacePlanCatalog(
      { ...filesystem, readFile },
      discovery,
      () => now,
    );
    const first = catalog.list(root);
    const concurrent = catalog.list(root);
    await vi.waitFor(() => expect(discovery.list).toHaveBeenCalledTimes(1));
    release();
    const entries = await first;
    expect(await concurrent).toBe(entries);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(await catalog.list(root)).toBe(entries);
    expect(discovery.list).toHaveBeenCalledTimes(1);

    now = 2_000;
    expect(await catalog.list(root)).toEqual(entries);
    expect(readFile).toHaveBeenCalledTimes(2);

    await writeFile(join(root, '.gestalt', 'first.org'), plan('Edited first plan'));
    await writeFile(join(root, '.gestalt', 'third.org'), plan('Third'));
    await rm(join(root, '.gestalt', 'second.org'));
    now = 4_000;
    expect(await catalog.list(root)).toEqual([
      expect.objectContaining({ planName: '.gestalt/first.org', title: 'Edited first plan' }),
      expect.objectContaining({ planName: '.gestalt/third.org', title: 'Third' }),
    ]);
    expect(readFile).toHaveBeenCalledTimes(4);
  });

  it('finds only Org files in .gestalt folders across repositories, including nested folders', async () => {
    const root = await workspace();
    await Promise.all([
      mkdir(join(root, '.gestalt')),
      mkdir(join(root, 'first', '.gestalt', 'nested'), { recursive: true }),
      mkdir(join(root, 'second', '.gestalt'), { recursive: true }),
      mkdir(join(root, 'first', '.git'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'ignored.org'), plan('Ignored')),
      writeFile(join(root, '.gestalt', 'legacy.org'), plan('Legacy')),
      writeFile(join(root, '.gestalt', 'invalid.org'), 'not an Org plan'),
      writeFile(join(root, '.gestalt', 'notes.txt'), plan('Ignored')),
      writeFile(join(root, 'first', '.gestalt', 'nested', 'deep.org'), plan('Deep')),
      writeFile(join(root, 'second', '.gestalt', 'same.org'), plan('Second')),
    ]);
    expect(await new FilesystemWorkspacePlanCatalog().list(root)).toEqual([
      expect.objectContaining({
        planName: '.gestalt/invalid.org',
        title: 'invalid',
        previewAvailable: false,
      }),
      expect.objectContaining({
        planName: '.gestalt/legacy.org',
        title: 'Legacy',
        previewAvailable: true,
      }),
      expect.objectContaining({ planName: 'first/.gestalt/nested/deep.org', title: 'Deep' }),
      expect.objectContaining({ planName: 'second/.gestalt/same.org', title: 'Second' }),
    ]);
  });

  it('returns a parsed projection for an encoded relative path and rejects traversal', async () => {
    const root = await workspace();
    await mkdir(join(root, 'plans'));
    await writeFile(join(root, 'plans', 'roadmap space.org'), plan('Roadmap'));
    const catalog = new FilesystemWorkspacePlanCatalog();

    await expect(catalog.read(root, 'plans/roadmap space.org')).resolves.toMatchObject({
      kind: 'available',
      plan: { title: 'Roadmap' },
      sourcePath: await filesystem.realpath(join(root, 'plans', 'roadmap space.org')),
    });
    await expect(catalog.read(root, '../roadmap space.org')).resolves.toEqual({ kind: 'missing' });
    await expect(catalog.read(root, 'roadmap\\plan.org')).resolves.toEqual({ kind: 'missing' });
  });

  it('treats missing workspaces as empty and rejects symlinked directories or files', async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, '.gestalt'));
    await writeFile(join(outside, 'outside.org'), plan('Outside'));
    await symlink(outside, join(root, '.gestalt', 'linked-directory'));
    await symlink(join(outside, 'outside.org'), join(root, '.gestalt', 'linked-file.org'));
    const catalog = new FilesystemWorkspacePlanCatalog();

    await expect(catalog.list(root)).resolves.toEqual([]);
    await expect(catalog.read(root, '.gestalt/linked-file.org')).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(catalog.list(join(root, 'missing'))).resolves.toEqual([]);
  });

  it('lists malformed Org files and returns their source preview', async () => {
    const root = await workspace();
    await mkdir(join(root, '.gestalt'));
    await writeFile(join(root, '.gestalt', 'bad.org'), 'bad');
    const catalog = new FilesystemWorkspacePlanCatalog();

    await expect(catalog.list(root)).resolves.toEqual([
      { planName: '.gestalt/bad.org', title: 'bad', previewAvailable: false },
    ]);
    await expect(catalog.read(root, '.gestalt/bad.org')).resolves.toEqual({
      kind: 'source',
      title: 'bad',
      source: 'bad',
      sourcePath: await filesystem.realpath(join(root, '.gestalt', 'bad.org')),
    });
    await expect(catalog.read(root, 'missing.org')).resolves.toEqual({ kind: 'missing' });
  });

  it('does not truncate the discovered catalog and keeps same filenames isolated by workspace', async () => {
    const first = await workspace();
    const second = await workspace();
    await Promise.all([mkdir(join(first, '.gestalt')), mkdir(join(second, '.gestalt'))]);
    await Promise.all([
      ...Array.from({ length: 101 }, (_, index) =>
        writeFile(
          join(first, '.gestalt', `${String(index).padStart(3, '0')}.org`),
          plan(`Plan ${index}`),
        ),
      ),
      writeFile(join(first, '.gestalt', 'oversized.org'), 'x'.repeat(1_048_577)),
      writeFile(join(second, '.gestalt', 'shared.org'), plan('Second workspace')),
      writeFile(join(first, '.gestalt', 'shared.org'), plan('First workspace')),
    ]);
    const catalog = new FilesystemWorkspacePlanCatalog();

    const listed = await catalog.list(first);
    expect(listed).toHaveLength(103);
    expect(listed).toContainEqual({
      planName: '.gestalt/oversized.org',
      title: 'oversized',
      previewAvailable: false,
    });
    await expect(catalog.read(first, '.gestalt/oversized.org')).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(catalog.read(first, '.gestalt/shared.org')).resolves.toMatchObject({
      kind: 'available',
      plan: { title: 'First workspace' },
    });
    await expect(catalog.read(second, '.gestalt/shared.org')).resolves.toMatchObject({
      kind: 'available',
      plan: { title: 'Second workspace' },
    });
  });
});
