/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerGetWorkspacePlan } from './get-workspace-plan/endpoint.js';
import { registerListWorkspacePlans } from './list-workspace-plans/endpoint.js';

const plan = {
  title: 'Catalog plan',
  steps: [],
  totalSteps: 1,
  doneSteps: 0,
  allDone: false,
  currentStepId: 'one',
};

describe('workspace plan catalog routes', () => {
  it('resolves an opaque workspace and decodes workspace-relative plan paths', async () => {
    const app = fastify();
    const reads: string[] = [];
    const deps = {
      workspaces: {
        resolve: async (id: string) => ({ id, name: 'workspace', realPath: '/workspace' }),
      },
      plans: {
        list: async () => [
          {
            planName: 'plans/roadmap space.org',
            title: 'Roadmap',
            totalSteps: 1,
            doneSteps: 0,
            allDone: false,
          },
        ],
        read: async (_path: string, planName: string) => {
          reads.push(planName);
          return { kind: 'available' as const, plan };
        },
      },
    };
    registerListWorkspacePlans(app, deps);
    registerGetWorkspacePlan(app, deps);

    expect((await app.inject('/api/workspaces/opaque/plans')).json()).toEqual([
      expect.objectContaining({ planName: 'plans/roadmap space.org' }),
    ]);
    const response = await app.inject('/api/workspaces/opaque/plans/plans%2Froadmap%20space.org');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: 'Catalog plan' });
    expect(reads).toEqual(['plans/roadmap space.org']);
    await app.close();
  });

  it('maps unknown workspaces, missing files, and invalid plans without session routes', async () => {
    const app = fastify();
    const deps = {
      workspaces: {
        resolve: async () => {
          throw new Error('WORKSPACE_NOT_FOUND');
        },
      },
      plans: { list: async () => [], read: async () => ({ kind: 'missing' as const }) },
    };
    registerListWorkspacePlans(app, deps);
    registerGetWorkspacePlan(app, deps);
    expect((await app.inject('/api/workspaces/nope/plans')).statusCode).toBe(404);
    expect((await app.inject('/api/workspaces/nope/plans/nope.org')).json()).toEqual({
      code: 'WORKSPACE_NOT_FOUND',
    });
    await app.close();

    const invalid = fastify();
    registerGetWorkspacePlan(invalid, {
      workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/workspace' }) },
      plans: { list: async () => [], read: async () => ({ kind: 'unavailable' }) },
    });
    expect((await invalid.inject('/api/workspaces/one/plans/bad.org')).statusCode).toBe(422);
    expect((await invalid.inject('/api/workspaces/one/plans/bad.org')).json()).toEqual({
      code: 'PLAN_UNAVAILABLE',
    });
    await invalid.close();
  });
});
