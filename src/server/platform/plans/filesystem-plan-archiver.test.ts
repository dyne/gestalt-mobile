/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemPlanArchiver } from './filesystem-plan-archiver.js';
import { FilesystemWorkspacePlanCatalog } from './filesystem-workspace-plan-catalog.js';
import { archiveOrgPlan, isArchivedOrgPlan } from './org-plan-archive-tag.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp('/tmp/mobile-plan-archive-');
  roots.push(root);
  await mkdir(`${root}/project/.gestalt`, { recursive: true });
  return root;
}

describe('Org archive tags', () => {
  it('preserves existing tags, CRLF and task content and is idempotent', () => {
    const source = '#+TITLE: Plan\r\n#+FILETAGS: :project:urgent:\r\n\r\n* TODO Task\r\n';
    const tagged = archiveOrgPlan(source);
    expect(tagged).toBe(source.replace(':project:urgent:', ':project:urgent:ARCHIVE:'));
    expect(archiveOrgPlan(tagged)).toBe(tagged);
    expect(isArchivedOrgPlan(tagged)).toBe(true);
    expect(isArchivedOrgPlan('#+filetags: :archive:\n')).toBe(true);
    expect(isArchivedOrgPlan('#+FILETAGS: :not-archive:\n')).toBe(false);
  });
  it('adds a file tag without changing an untagged plan', () => {
    expect(archiveOrgPlan('#+TITLE: Plan\n* TODO Task\n')).toBe(
      '#+FILETAGS: :ARCHIVE:\n#+TITLE: Plan\n* TODO Task\n',
    );
  });
});

describe('FilesystemPlanArchiver', () => {
  it('persists the tag, preserves file mode, and forces a fresh catalog within its cache window', async () => {
    const root = await workspace();
    const name = 'project/.gestalt/plan.org';
    const source =
      '#+TITLE: Archive me\n\n* TODO [#A] First task\n:PROPERTIES:\n:ID: first-task\n:SKILLS: $gestalt:development-testing\n:REVIEW_STATUS: UNREVIEWED\n:END:\n- Effort :: Small\n- Goal :: Keep unfinished tasks unfinished.\n- Notes :: Preserve tasks.\n';
    await writeFile(`${root}/${name}`, source);
    await chmod(`${root}/${name}`, 0o640);
    const catalog = new FilesystemWorkspacePlanCatalog();
    expect((await catalog.list(root))[0]?.archived).toBeUndefined();
    const archiver = new FilesystemPlanArchiver();
    const [first, second] = await Promise.all([
      archiver.archive(root, name),
      archiver.archive(root, name),
    ]);
    expect(first).toEqual({ kind: 'archived' });
    expect(second).toEqual(first);
    expect(await readFile(`${root}/${name}`, 'utf8')).toBe(`#+FILETAGS: :ARCHIVE:\n${source}`);
    expect((await stat(`${root}/${name}`)).mode & 0o777).toBe(0o640);
    expect((await catalog.list(root, true))[0]).toMatchObject({
      archived: true,
      allDone: false,
      doneSteps: 0,
      totalSteps: 1,
    });
    await expect(archiver.archive(root, name)).resolves.toEqual({ kind: 'archived' });
    expect(await readFile(`${root}/${name}`, 'utf8')).toBe(`#+FILETAGS: :ARCHIVE:\n${source}`);
  });
  it('rejects traversal, non-plan paths and symlinks without changing their targets', async () => {
    const root = await workspace();
    const outside = await workspace();
    const source = '#+TITLE: Outside';
    await writeFile(`${outside}/project/.gestalt/plan.org`, source);
    await symlink(`${outside}/project/.gestalt/plan.org`, `${root}/project/.gestalt/link.org`);
    await symlink(`${outside}/project`, `${root}/alias`);
    const archiver = new FilesystemPlanArchiver();
    await expect(archiver.archive(root, '../project/.gestalt/plan.org')).resolves.toEqual({
      kind: 'missing',
    });
    await expect(archiver.archive(root, 'notes.org')).resolves.toEqual({ kind: 'missing' });
    await expect(archiver.archive(root, 'project/.gestalt/link.org')).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(archiver.archive(root, 'alias/.gestalt/plan.org')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(await readFile(`${outside}/project/.gestalt/plan.org`, 'utf8')).toBe(source);
  });
  it('does not overwrite an edit made before the tag is published', async () => {
    const root = await workspace();
    const name = 'project/.gestalt/plan.org';
    await writeFile(`${root}/${name}`, '#+TITLE: Original');
    const edit = '#+TITLE: Updated by another writer';
    const archiver = new FilesystemPlanArchiver(async () => {
      await writeFile(`${root}/${name}`, edit);
    });
    await expect(archiver.archive(root, name)).resolves.toEqual({ kind: 'conflict' });
    expect(await readFile(`${root}/${name}`, 'utf8')).toBe(edit);
  });
});
