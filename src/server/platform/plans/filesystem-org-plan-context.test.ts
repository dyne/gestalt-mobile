/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemWorkspaceCatalog } from '../catalog/filesystem-workspace-catalog.js';
import { FilesystemWorkspacePlanCatalog } from './filesystem-workspace-plan-catalog.js';
import { FilesystemOrgPlanContext } from './filesystem-org-plan-context.js';
import { prepareOrgPlanSupervision } from '../../features/plans/application/prepare-org-plan-supervision.js';
import { assessModelPolicyAdmission } from '../../features/plans/domain/model-policy-admission.js';
import type { OrgPlanReference } from '../../../shared/contracts/org-plan-execution.js';
import { newSessionFallback } from '../../../shared/contracts/session-defaults.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const source = `#+TITLE: Project context
* TODO [#A] Work
:PROPERTIES:
:ID: work
:SKILLS: $gestalt:coding
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Context test.
- Notes :: Do not trust project prose: /some/other/project.
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'org-plan-context-'));
  roots.push(root);
  const workspaces = new FilesystemWorkspaceCatalog(root);
  const plans = new FilesystemWorkspacePlanCatalog();
  const sessions = new Map<
    string,
    { workspaceId: string; workspacePath: string; lastOrgPlan?: { path: string } }
  >();
  const context = new FilesystemOrgPlanContext(workspaces, (id) => sessions.get(id) ?? null);
  const prepare = (reference: OrgPlanReference, expectedRevision?: string) =>
    prepareOrgPlanSupervision(
      reference,
      {
        resolveReference: (ref) => context.resolveReference(ref),
        read: (path, name) => plans.readExecution(path, name),
        workspace: (path, revision) => context.workspace(path, revision),
        runtimeAvailable: async () => ({ available: true }),
        owner: async () => null,
        policy: assessModelPolicyAdmission,
        settings: async () => ({
          kind: 'available' as const,
          settings: {
            ...newSessionFallback,
            provider: 'codex' as const,
            profile: 'default' as const,
            skillProfile: '',
          },
          skillProfiles: [],
          warnings: [],
          effectiveSkillSelection: { skills: [] },
        }),
      },
      expectedRevision,
    );
  const rootId = (await workspaces.list())[0]!.id;
  return { root, workspaces, context, prepare, sessions, rootId };
}

describe('FilesystemOrgPlanContext', () => {
  it('uses one authorized snapshot without resolving every unrelated catalog node', async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 150 }, (_, index) =>
        mkdir(join(f.root, `unrelated-${index}`, 'child'), { recursive: true }),
      ),
    );
    await mkdir(join(f.root, 'project', '.gestalt'), { recursive: true });
    await writeFile(join(f.root, 'project', '.gestalt', 'plan.org'), source);
    const snapshot = vi.spyOn(f.workspaces, 'snapshot');
    const resolve = vi.spyOn(f.workspaces, 'resolve');
    const list = vi.spyOn(f.workspaces, 'list');
    const result = await f.prepare({
      kind: 'workspace',
      workspaceId: f.rootId,
      planName: 'project/.gestalt/plan.org',
    });
    expect(result).toMatchObject({
      kind: 'eligible',
      workspace: { path: join(f.root, 'project') },
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect((await snapshot.mock.results[0]!.value).length).toBeGreaterThan(300);
    // The sole resolve checks the incoming root identity (its fast path); no per-node scans.
    expect(resolve).toHaveBeenCalledExactlyOnceWith(f.rootId);
    expect(list).not.toHaveBeenCalled();
  });
  it.each(['directory', 'worktree file'])(
    'chooses the plan project (%s), independently of root catalog and another session/base',
    async (kind) => {
      const f = await fixture();
      const project = join(f.root, 'Project ü space');
      await mkdir(join(project, '.gestalt', 'subfolder'), { recursive: true });
      if (kind === 'directory') await mkdir(join(project, '.git'));
      else await writeFile(join(project, '.git'), 'gitdir: /external/worktrees/project');
      await mkdir(join(f.root, 'other-session-base'));
      const other = (await f.workspaces.list())[0]!.children.find(
        (item) => item.name === 'other-session-base',
      )!;
      f.sessions.set('selected-other', {
        workspaceId: other.id,
        workspacePath: join(f.root, 'other-session-base'),
      });
      await writeFile(join(project, '.gestalt', 'subfolder', '计划 space.org'), source);
      const prepared = await f.prepare({
        kind: 'workspace',
        workspaceId: f.rootId,
        planName: 'Project ü space/.gestalt/subfolder/计划 space.org',
      });
      expect(prepared).toMatchObject({ kind: 'eligible', workspace: { path: project } });
      if (prepared.kind !== 'eligible') throw new Error('fixture');
      expect((await f.workspaces.resolve(prepared.workspace.id)).realPath).toBe(project);
      expect(prepared.workspace.path).not.toBe(join(f.root, 'other-session-base'));
      const projectId = prepared.workspace.id;
      f.sessions.set('linked', {
        workspaceId: projectId,
        workspacePath: project,
        lastOrgPlan: { path: join(project, '.gestalt', 'subfolder', '计划 space.org') },
      });
      for (const reference of [
        {
          kind: 'session' as const,
          sessionId: 'linked',
          planName: '.gestalt/subfolder/计划 space.org',
        },
        { kind: 'retained-session' as const, sessionId: 'linked' },
      ]) {
        expect(await f.prepare(reference)).toMatchObject({
          kind: 'eligible',
          revision: prepared.revision,
          workspace: prepared.workspace,
          sourcePath: prepared.sourcePath,
        });
      }
    },
  );

  it('selects a nonrepo .gestalt owner and nearest catalog ancestor without selecting hidden plan folders', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'owner', '.gestalt', 'nested'), { recursive: true });
    await writeFile(join(f.root, 'owner', '.gestalt', 'nested', 'plan.org'), source);
    expect(
      await f.prepare({
        kind: 'workspace',
        workspaceId: f.rootId,
        planName: 'owner/.gestalt/nested/plan.org',
      }),
    ).toMatchObject({ kind: 'eligible', workspace: { path: join(f.root, 'owner') } });
    await mkdir(join(f.root, 'plain', 'plans'), { recursive: true });
    await writeFile(join(f.root, 'plain', 'plans', 'plan.org'), source);
    expect(
      await f.prepare({
        kind: 'workspace',
        workspaceId: f.rootId,
        planName: 'plain/plans/plan.org',
      }),
    ).toMatchObject({ kind: 'eligible', workspace: { path: join(f.root, 'plain', 'plans') } });
  });

  it('blocks an unselectable nested repo and never widens scope for retained or forged references', async () => {
    const f = await fixture();
    await mkdir(join(f.root, '.git'));
    await mkdir(join(f.root, 'nested', '.git'), { recursive: true });
    await mkdir(join(f.root, 'nested', '.gestalt'));
    await writeFile(join(f.root, 'nested', '.gestalt', 'plan.org'), source);
    expect(
      await f.prepare({
        kind: 'workspace',
        workspaceId: f.rootId,
        planName: 'nested/.gestalt/plan.org',
      }),
    ).toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    f.sessions.set('outside', {
      workspaceId: f.rootId,
      workspacePath: f.root,
      lastOrgPlan: { path: '/outside/.gestalt/plan.org' },
    });
    expect(await f.prepare({ kind: 'retained-session', sessionId: 'outside' })).toMatchObject({
      code: 'REFERENCE_UNAVAILABLE',
    });
    f.sessions.set('forged', { workspaceId: f.rootId, workspacePath: '/outside' });
    expect(
      await f.prepare({
        kind: 'session',
        sessionId: 'forged',
        planName: 'nested/.gestalt/plan.org',
      }),
    ).toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    expect(
      await f.prepare({ kind: 'workspace', workspaceId: f.rootId, planName: '/outside/plan.org' }),
    ).toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it.each(['edited', 'deleted', 'moved', 'replaced', 'workspace changed'])(
    'requires refresh and confirmation after the file/context is %s',
    async (change) => {
      const f = await fixture();
      const project = join(f.root, 'project');
      await mkdir(join(project, '.gestalt'), { recursive: true });
      const path = join(project, '.gestalt', 'plan.org');
      await writeFile(path, source);
      const reference = {
        kind: 'workspace' as const,
        workspaceId: f.rootId,
        planName: 'project/.gestalt/plan.org',
      };
      const before = await f.prepare(reference);
      if (before.kind !== 'eligible') throw new Error('fixture');
      expect(await f.prepare(reference, before.revision)).toMatchObject({
        kind: 'eligible',
        revision: before.revision,
      });
      if (change === 'edited')
        await writeFile(path, source.replace('Project context', 'Changed context'));
      if (change === 'deleted') await rm(path);
      if (change === 'moved') await rename(path, join(project, '.gestalt', 'moved.org'));
      if (change === 'replaced') {
        const original = await stat(path);
        const replacement = join(project, '.gestalt', 'replacement.org');
        await writeFile(replacement, source);
        await utimes(replacement, original.atime, original.mtime);
        await rename(replacement, path);
      }
      if (change === 'workspace changed') await mkdir(join(project, '.git'));
      expect(await f.prepare(reference, before.revision)).toMatchObject({
        kind: 'blocked',
        code: 'CONTEXT_CHANGED',
      });
    },
  );
});
