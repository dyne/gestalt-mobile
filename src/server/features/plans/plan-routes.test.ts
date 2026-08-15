/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerClosePlan } from './close-plan/endpoint.js';
import { registerGetPlan } from './get-plan/endpoint.js';
import type { SupervisedPlan } from './domain/supervised-plan.js';

const complete: SupervisedPlan = {
  title: 'Complete',
  steps: [],
  totalSteps: 1,
  doneSteps: 1,
  allDone: true,
  currentStepId: 'done',
};
const incomplete: SupervisedPlan = {
  ...complete,
  title: 'Incomplete',
  allDone: false,
  doneSteps: 0,
};

describe('session plan REPR routes', () => {
  it('returns no content until a session owns a retained plan and isolates unknown sessions', async () => {
    const app = fastify();
    registerGetPlan(app, { exists: (id) => id === 'one', refresh: async () => null });
    expect((await app.inject('/api/sessions/one/plan')).statusCode).toBe(204);
    expect((await app.inject('/api/sessions/two/plan')).statusCode).toBe(404);
    await app.close();
  });

  it('awaits a fresh plan projection for every GET', async () => {
    const app = fastify();
    let reads = 0;
    registerGetPlan(app, {
      exists: () => true,
      refresh: async () => ({ ...incomplete, title: `Filesystem plan ${++reads}` }),
    });

    expect((await app.inject('/api/sessions/one/plan')).json().title).toBe('Filesystem plan 1');
    expect((await app.inject('/api/sessions/one/plan')).json().title).toBe('Filesystem plan 2');
    await app.close();
  });

  it('returns the complete projection and closes only a completed plan idempotently', async () => {
    const app = fastify();
    let plan: SupervisedPlan | null = complete;
    const closed: string[] = [];
    const removed: string[] = [];
    const deps = {
      exists: (id: string) => id === 'one',
      find: () => plan,
      refresh: async () => plan,
      removeStatus: async (id: string) => {
        removed.push(id);
      },
      clear: () => {
        plan = null;
      },
      closed: (id: string) => closed.push(id),
    };
    registerGetPlan(app, deps);
    registerClosePlan(app, deps);
    expect((await app.inject('/api/sessions/one/plan')).json()).toMatchObject({
      title: 'Complete',
      allDone: true,
    });
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/one/plan' })).statusCode).toBe(
      204,
    );
    expect(removed).toEqual(['one']);
    expect(closed).toEqual(['one']);
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/one/plan' })).statusCode).toBe(
      204,
    );
    await app.close();
  });

  it('uses an RFC 9457 problem without paths for incomplete or unavailable closes', async () => {
    const app = fastify();
    registerClosePlan(app, {
      exists: () => true,
      find: () => incomplete,
      removeStatus: async () => {},
      clear: () => {},
      closed: () => {},
    });
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/one/plan' });
    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'PLAN_INCOMPLETE', status: 409 });
    await app.close();
  });

  it('maps status adapter removal failures to 503 without clearing or closing the retained plan', async () => {
    const app = fastify();
    let cleared = 0;
    let closed = 0;
    registerClosePlan(app, {
      exists: () => true,
      find: () => complete,
      removeStatus: async () => {
        throw new Error('filesystem unavailable');
      },
      clear: () => {
        cleared += 1;
      },
      closed: () => {
        closed += 1;
      },
    });
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/one/plan' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'PLAN_CLOSE_UNAVAILABLE', status: 503 });
    expect(cleared).toBe(0);
    expect(closed).toBe(0);
    await app.close();
  });

  it('keeps GET and DELETE ownership isolated between two sessions', async () => {
    const app = fastify();
    const plans = new Map<string, SupervisedPlan>([
      ['one', complete],
      ['two', { ...complete, title: 'Other session plan' }],
    ]);
    const sessions = new Set(['one', 'two']);
    const removed: string[] = [];
    const closed: string[] = [];
    const deps = {
      exists: (id: string) => sessions.has(id),
      find: (id: string) => plans.get(id) ?? null,
      refresh: async (id: string) => plans.get(id) ?? null,
      removeStatus: async (id: string) => {
        removed.push(id);
      },
      clear: (id: string) => {
        plans.delete(id);
      },
      closed: (id: string) => closed.push(id),
    };
    registerGetPlan(app, deps);
    registerClosePlan(app, deps);
    expect((await app.inject('/api/sessions/one/plan')).json()).toMatchObject({
      title: 'Complete',
    });
    expect((await app.inject('/api/sessions/two/plan')).json()).toMatchObject({
      title: 'Other session plan',
    });
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/one/plan' })).statusCode).toBe(
      204,
    );
    expect((await app.inject('/api/sessions/one/plan')).statusCode).toBe(204);
    expect((await app.inject('/api/sessions/two/plan')).json()).toMatchObject({
      title: 'Other session plan',
    });
    expect(removed).toEqual(['one']);
    expect(closed).toEqual(['one']);
    await app.close();
  });
});
