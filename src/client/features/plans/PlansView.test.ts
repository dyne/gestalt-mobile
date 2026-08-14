/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PlansView from './PlansView.svelte';

afterEach(cleanup);

const entry = {
  planName: 'roadmap.org',
  title: 'Roadmap',
  subtitle: 'Local',
  totalSteps: 2,
  doneSteps: 1,
  allDone: false,
};
const plan = {
  title: 'Roadmap',
  steps: [],
  totalSteps: 2,
  doneSteps: 1,
  allDone: false,
  currentStepId: 'one',
};

describe('PlansView', () => {
  it('renders no-workspace, loading, empty, and error catalog states', () => {
    const { rerender } = render(PlansView, {
      catalog: { kind: 'no-workspace' },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });
    expect(screen.getByText('Select a workspace to browse its local plans.')).toBeTruthy();
    rerender({
      catalog: { kind: 'loading', workspaceId: 'one' },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });
    expect(screen.getByText('Loading workspace plans…')).toBeTruthy();
    rerender({
      catalog: { kind: 'ready', workspaceId: 'one', entries: [] },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });
    expect(screen.getByText('No valid Org plans were found below this workspace.')).toBeTruthy();
    rerender({
      catalog: { kind: 'error', workspaceId: 'one', error: 'Offline' },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });
    expect(screen.getByText('Offline')).toBeTruthy();
  });

  it('opens semantic catalog buttons and returns from the viewer without a destructive callback', async () => {
    const onopen = vi.fn();
    const onclose = vi.fn();
    const { rerender } = render(PlansView, {
      catalog: { kind: 'ready', workspaceId: 'one', entries: [entry] },
      state: null,
      onopen,
      onclose,
    });
    const item = screen.getByRole('button', { name: /Roadmap.*roadmap.org.*1 \/ 2 complete/ });
    await fireEvent.click(item);
    expect(onopen).toHaveBeenCalledWith('roadmap.org');

    rerender({
      catalog: { kind: 'ready', workspaceId: 'one', entries: [entry] },
      state: { kind: 'ready', sessionId: 'catalog', plan },
      onopen,
      onclose,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Close plan and return to list' }));
    expect(onclose).toHaveBeenCalledTimes(1);
    rerender({
      catalog: { kind: 'ready', workspaceId: 'one', entries: [entry] },
      state: null,
      onopen,
      onclose,
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /Roadmap.*roadmap.org.*1 \/ 2 complete/ }),
      ),
    );
  });

  it('shows and opens a workspace-relative nested plan path', async () => {
    const onopen = vi.fn();
    render(PlansView, {
      catalog: {
        kind: 'ready',
        workspaceId: 'one',
        entries: [{ ...entry, planName: 'plans/releases/roadmap.org' }],
      },
      state: null,
      onopen,
      onclose: vi.fn(),
    });

    expect(screen.getByText('Org plans validated below the selected workspace.')).toBeTruthy();
    await fireEvent.click(
      screen.getByRole('button', { name: /Roadmap.*plans\/releases\/roadmap.org/ }),
    );
    expect(onopen).toHaveBeenCalledWith('plans/releases/roadmap.org');
  });

  it('preserves closing and error plan states for the plan viewer', () => {
    const props = {
      catalog: { kind: 'ready' as const, workspaceId: 'one', entries: [entry] },
      state: { kind: 'closing' as const, sessionId: 'one', plan },
      onopen: vi.fn(),
      onclose: vi.fn(),
    };
    const { container, rerender } = render(PlansView, props);
    expect(screen.getByText('Closing completed plan.')).toBeTruthy();

    rerender({
      ...props,
      state: { kind: 'error', sessionId: 'one', plan, error: 'Close failed.' },
    });
    expect(screen.getByText('Close failed.')).toBeTruthy();
    expect(container.querySelector('[aria-live]')?.textContent).toContain('Close failed.');
  });
});
