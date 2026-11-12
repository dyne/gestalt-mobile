/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { FilesystemWorkspacePlanCatalog } from '../../../platform/plans/filesystem-workspace-plan-catalog.js';
import { FilesystemOrgPlanContext } from '../../../platform/plans/filesystem-org-plan-context.js';
import type { OrgPlanReference } from '../../../../shared/contracts/org-plan-execution.js';
import { registerDownloadOrgPlan } from './endpoint.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-download-'));
  const workspacePath = join(root, 'workspace');
  await mkdir(join(workspacePath, '.gestalt'), { recursive: true });
  const planName = ".gestalt/Plan é's.org";
  const source =
    '#+TITLE: Original Ω\r\n# Keep this comment.\r\n* Notes\r\n  Original spacing.\r\n';
  await writeFile(join(workspacePath, planName), source);
  const workspace = { id: 'project', name: 'Project', realPath: workspacePath };
  const context = new FilesystemOrgPlanContext(
    {
      resolve: async (id) => {
        if (id !== workspace.id) throw new Error('WORKSPACE_NOT_FOUND');
        return workspace;
      },
      snapshot: async () => [workspace],
    },
    (id) =>
      id === 'session'
        ? {
            workspaceId: workspace.id,
            workspacePath,
            lastOrgPlan: { path: join(workspacePath, planName) },
          }
        : null,
  );
  const catalog = new FilesystemWorkspacePlanCatalog();
  const app = fastify();
  registerDownloadOrgPlan(app, {
    resolveReference: (reference) => context.resolveReference(reference),
    readSource: (path, name) => catalog.readSource(path, name),
  });
  onTestFinished(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const download = (reference: OrgPlanReference | Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/plans/download',
      payload: reference,
    });
  return { root, workspacePath, planName, source, download };
}

it.each(['workspace', 'session', 'retained-session'] as const)(
  'downloads original source and a safely encoded filename from a %s reference',
  async (kind) => {
    const f = await fixture();
    const reference: OrgPlanReference =
      kind === 'workspace'
        ? { kind, workspaceId: 'project', planName: f.planName }
        : kind === 'session'
          ? { kind, sessionId: 'session', planName: f.planName }
          : { kind, sessionId: 'session' };
    const response = await f.download(reference);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(f.source);
    expect(response.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''Plan%20%C3%A9%27s.org",
    );
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  },
);

it('rejects invalid references, unknown workspaces and missing retained sessions', async () => {
  const f = await fixture();
  expect((await f.download({ path: '/outside/plan.org' })).statusCode).toBe(400);
  expect(
    (await f.download({ kind: 'workspace', workspaceId: 'missing', planName: f.planName }))
      .statusCode,
  ).toBe(404);
  expect((await f.download({ kind: 'retained-session', sessionId: 'missing' })).statusCode).toBe(
    404,
  );
});

it('refuses traversal, symlink escapes and files beyond the viewer size limit', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside.org');
  await writeFile(outside, 'outside source');
  await symlink(outside, join(f.workspacePath, '.gestalt', 'link.org'));
  await writeFile(join(f.workspacePath, '.gestalt', 'large.org'), Buffer.alloc(1_048_577));
  for (const [planName, expected] of [
    ['../outside.org', 404],
    ['.gestalt/link.org', 422],
    ['.gestalt/large.org', 422],
  ] as const) {
    const response = await f.download({ kind: 'workspace', workspaceId: 'project', planName });
    expect(response.statusCode).toBe(expected);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.body).not.toContain('outside source');
  }
});
