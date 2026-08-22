/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerOpenPlan } from './endpoint.js';

const plan = {
  title: 'Selected plan',
  steps: [],
  totalSteps: 1,
  doneSteps: 0,
  allDone: false,
  currentStepId: 'one',
};

describe('open session plan endpoint', () => {
  it('associates a workspace-relative supervised plan with a known session', async () => {
    const open = vi.fn(async () => ({ kind: 'available' as const, plan }));
    const app = fastify();
    registerOpenPlan(app, { exists: (id) => id === 'session-1', open });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/sessions/session-1/plan',
      payload: { planName: 'plans/roadmap.org' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: 'Selected plan' });
    expect(open).toHaveBeenCalledWith('session-1', 'plans/roadmap.org');
    await app.close();
  });

  it('keeps ordinary Org documents previewable without treating them as supervised', async () => {
    const app = fastify();
    registerOpenPlan(app, {
      exists: () => true,
      open: async () => ({
        kind: 'source',
        title: 'Notes',
        source: '#+TITLE: Notes\n* Topic',
      }),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/sessions/session-1/plan',
      payload: { planName: 'notes.org' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: 'org-source',
      planName: 'notes.org',
      title: 'Notes',
      source: '#+TITLE: Notes\n* Topic',
    });
    await app.close();
  });

  it('rejects unknown sessions, invalid input, and missing plans', async () => {
    const app = fastify();
    registerOpenPlan(app, {
      exists: (id) => id === 'known',
      open: async () => ({ kind: 'missing' }),
    });

    expect(
      (await app.inject({ method: 'PUT', url: '/api/sessions/missing/plan', payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/sessions/known/plan', payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/sessions/known/plan',
          payload: { planName: 'missing.org' },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});
