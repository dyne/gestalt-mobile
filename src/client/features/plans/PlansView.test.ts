/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PlansView from './PlansView.svelte';

afterEach(cleanup);

const entry = { planName: 'roadmap.org', title: 'Roadmap', subtitle: 'Local', totalSteps: 2, doneSteps: 1, allDone: false };
const plan = { title: 'Roadmap', steps: [], totalSteps: 2, doneSteps: 1, allDone: false, currentStepId: 'one' };

describe('PlansView', () => {
  it('renders no-workspace, loading, empty, and error catalog states', () => {
    const { rerender } = render(PlansView, { catalog: { kind: 'no-workspace' }, plan: null, onopen: vi.fn(), onclose: vi.fn() });
    expect(screen.getByText('Select a workspace to browse its local plans.')).toBeTruthy();
    rerender({ catalog: { kind: 'loading', workspaceId: 'one' }, plan: null, onopen: vi.fn(), onclose: vi.fn() });
    expect(screen.getByText('Loading workspace plans…')).toBeTruthy();
    rerender({ catalog: { kind: 'ready', workspaceId: 'one', entries: [] }, plan: null, onopen: vi.fn(), onclose: vi.fn() });
    expect(screen.getByText('No local plans are available in this workspace.')).toBeTruthy();
    rerender({ catalog: { kind: 'error', workspaceId: 'one', error: 'Offline' }, plan: null, onopen: vi.fn(), onclose: vi.fn() });
    expect(screen.getByText('Offline')).toBeTruthy();
  });

  it('opens semantic catalog buttons and returns from the viewer without a destructive callback', async () => {
    const onopen = vi.fn();
    const onclose = vi.fn();
    const { rerender } = render(PlansView, {
      catalog: { kind: 'ready', workspaceId: 'one', entries: [entry] },
      plan: null,
      onopen,
      onclose,
    });
    const item = screen.getByRole('button', { name: /Roadmap.*roadmap.org.*1 \/ 2 complete/ });
    await fireEvent.click(item);
    expect(onopen).toHaveBeenCalledWith('roadmap.org');

    rerender({ catalog: { kind: 'ready', workspaceId: 'one', entries: [entry] }, plan, onopen, onclose });
    await fireEvent.click(screen.getByRole('button', { name: 'Close plan and return to list' }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
