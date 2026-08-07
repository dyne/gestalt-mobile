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
  await mkdir(join(root, '.gestalt'));
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
  it('lists valid direct-child Org plans in filename order without paths or session side effects', async () => {
    const root = await workspace();
    await Promise.all([
      writeFile(join(root, '.gestalt', 'zeta.org'), plan('Zeta')),
      writeFile(join(root, '.gestalt', 'alpha.org'), plan('Alpha')),
      writeFile(join(root, '.gestalt', 'invalid.org'), 'not an Org plan'),
      writeFile(join(root, '.gestalt', 'notes.txt'), plan('Ignored')),
      mkdir(join(root, '.gestalt', 'nested')),
    ]);
    await writeFile(join(root, '.gestalt', 'nested', 'hidden.org'), plan('Hidden'));

    const entries = await new FilesystemWorkspacePlanCatalog().list(root);

    expect(entries).toEqual([
      expect.objectContaining({
        planName: 'alpha.org',
        title: 'Alpha',
        totalSteps: 1,
        doneSteps: 0,
      }),
      expect.objectContaining({ planName: 'zeta.org', title: 'Zeta', totalSteps: 1, doneSteps: 0 }),
    ]);
    expect(JSON.stringify(entries)).not.toContain(root);
  });

  it('returns a parsed projection for an opaque direct-child filename and rejects traversal', async () => {
    const root = await workspace();
    await writeFile(join(root, '.gestalt', 'roadmap space.org'), plan('Roadmap'));
    const catalog = new FilesystemWorkspacePlanCatalog();

    await expect(catalog.read(root, 'roadmap space.org')).resolves.toMatchObject({
      kind: 'available',
      plan: { title: 'Roadmap' },
    });
    await expect(catalog.read(root, '../roadmap space.org')).resolves.toEqual({ kind: 'missing' });
    await expect(catalog.read(root, 'nested/roadmap.org')).resolves.toEqual({ kind: 'missing' });
    await expect(catalog.read(root, 'roadmap\\plan.org')).resolves.toEqual({ kind: 'missing' });
  });

  it('treats missing catalogs as empty and rejects symlinked directories or files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-workspace-plans-'));
    roots.push(root);
    const catalog = new FilesystemWorkspacePlanCatalog();
    await expect(catalog.list(root)).resolves.toEqual([]);

    const outside = await workspace();
    await writeFile(join(outside, '.gestalt', 'outside.org'), plan('Outside'));
    await symlink(join(outside, '.gestalt'), join(root, '.gestalt'));
    await expect(catalog.list(root)).resolves.toEqual([]);

    await rm(join(root, '.gestalt'));
    await mkdir(join(root, '.gestalt'));
    await symlink(join(outside, '.gestalt', 'outside.org'), join(root, '.gestalt', 'link.org'));
    await expect(catalog.list(root)).resolves.toEqual([]);
    await expect(catalog.read(root, 'link.org')).resolves.toEqual({ kind: 'unavailable' });
  });

  it('excludes malformed plans from a catalog while exposing a typed direct-read failure', async () => {
    const root = await workspace();
    await writeFile(join(root, '.gestalt', 'bad.org'), 'bad');
    const catalog = new FilesystemWorkspacePlanCatalog();

    await expect(catalog.list(root)).resolves.toEqual([]);
    await expect(catalog.read(root, 'bad.org')).resolves.toEqual({ kind: 'unavailable' });
    await expect(catalog.read(root, 'missing.org')).resolves.toEqual({ kind: 'missing' });
  });

  it('bounds catalog count and file size while keeping same filenames isolated by workspace', async () => {
    const first = await workspace();
    const second = await workspace();
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
    expect(listed).toHaveLength(100);
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
