/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemWorkspacePlanCatalog } from './filesystem-workspace-plan-catalog.js';

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
  it('lists every recursively discovered Org file in relative-path order without helper validation', async () => {
    const root = await workspace();
    await Promise.all([
      mkdir(join(root, '.gestalt')),
      mkdir(join(root, 'plans', 'nested'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'zeta.org'), plan('Zeta')),
      writeFile(join(root, 'plans', 'alpha.org'), plan('Alpha')),
      writeFile(join(root, 'plans', 'nested', 'deep.org'), plan('Deep')),
      writeFile(join(root, '.gestalt', 'legacy.org'), plan('Legacy')),
      writeFile(join(root, 'rejected.org'), plan('Rejected')),
      writeFile(join(root, '.gestalt', 'invalid.org'), 'not an Org plan'),
      writeFile(join(root, '.gestalt', 'notes.txt'), plan('Ignored')),
    ]);
    const entries = await new FilesystemWorkspacePlanCatalog().list(root);

    expect(entries).toEqual([
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
      expect.objectContaining({
        planName: 'plans/alpha.org',
        title: 'Alpha',
        previewAvailable: true,
        totalSteps: 1,
        doneSteps: 0,
      }),
      expect.objectContaining({ planName: 'plans/nested/deep.org', title: 'Deep' }),
      expect.objectContaining({
        planName: 'rejected.org',
        title: 'Rejected',
        previewAvailable: true,
      }),
      expect.objectContaining({ planName: 'zeta.org', title: 'Zeta', totalSteps: 1, doneSteps: 0 }),
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
    await writeFile(join(outside, 'outside.org'), plan('Outside'));
    await symlink(outside, join(root, 'linked-directory'));
    await symlink(join(outside, 'outside.org'), join(root, 'linked-file.org'));
    const catalog = new FilesystemWorkspacePlanCatalog();

    await expect(catalog.list(root)).resolves.toEqual([]);
    await expect(catalog.read(root, 'linked-file.org')).resolves.toEqual({ kind: 'unavailable' });
    await expect(catalog.list(join(root, 'missing'))).resolves.toEqual([]);
  });

  it('lists malformed Org files and returns their source preview', async () => {
    const root = await workspace();
    await writeFile(join(root, 'bad.org'), 'bad');
    const catalog = new FilesystemWorkspacePlanCatalog();

    await expect(catalog.list(root)).resolves.toEqual([
      { planName: 'bad.org', title: 'bad', previewAvailable: false },
    ]);
    await expect(catalog.read(root, 'bad.org')).resolves.toEqual({
      kind: 'source',
      title: 'bad',
      source: 'bad',
    });
    await expect(catalog.read(root, 'missing.org')).resolves.toEqual({ kind: 'missing' });
  });

  it('does not truncate the discovered catalog and keeps same filenames isolated by workspace', async () => {
    const first = await workspace();
    const second = await workspace();
    await Promise.all([
      ...Array.from({ length: 101 }, (_, index) =>
        writeFile(join(first, `${String(index).padStart(3, '0')}.org`), plan(`Plan ${index}`)),
      ),
      writeFile(join(first, 'oversized.org'), 'x'.repeat(1_048_577)),
      writeFile(join(second, 'shared.org'), plan('Second workspace')),
      writeFile(join(first, 'shared.org'), plan('First workspace')),
    ]);
    const catalog = new FilesystemWorkspacePlanCatalog();

    const listed = await catalog.list(first);
    expect(listed).toHaveLength(103);
    expect(listed).toContainEqual({
      planName: 'oversized.org',
      title: 'oversized',
      previewAvailable: false,
    });
    await expect(catalog.read(first, 'oversized.org')).resolves.toEqual({ kind: 'unavailable' });
    await expect(catalog.read(first, 'shared.org')).resolves.toMatchObject({
      kind: 'available',
      plan: { title: 'First workspace' },
    });
    await expect(catalog.read(second, 'shared.org')).resolves.toMatchObject({
      kind: 'available',
      plan: { title: 'Second workspace' },
    });
  });
});
