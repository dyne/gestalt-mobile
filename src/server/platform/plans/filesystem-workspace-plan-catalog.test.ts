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
