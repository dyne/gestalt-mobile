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
  previewAvailable: true,
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
  it('shows compact paths and progress, reserves inline update status, and moves archived rows while preserving focus', async () => {
    const name = 'group/repository/.gestalt/deep/roadmap.org';
    const onarchive = vi.fn();
    const props = {
      catalog: {
        kind: 'ready' as const,
        workspaceId: 'root',
        refreshing: true,
        entries: [{ ...entry, planName: name }],
      },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
      onarchive,
    };
    const { rerender } = render(PlansView, props);
    const heading = screen.getByRole('heading', { name: 'ORG Plans' });
    expect(screen.getByRole('status').parentElement).toBe(heading.parentElement);
    expect(screen.getByText('group/repository')).toBeTruthy();
    expect(screen.getByText('roadmap.org').parentElement?.getAttribute('title')).toBe(name);
    const progress = screen.getByRole('progressbar', { name: 'Completion for Roadmap' });
    expect(progress.getAttribute('value')).toBe('1');
    expect(progress.getAttribute('max')).toBe('2');
    await fireEvent.click(screen.getByRole('button', { name: 'Archive Roadmap' }));
    expect(onarchive).toHaveBeenCalledWith(name);
    await rerender({
      ...props,
      catalog: {
        ...props.catalog,
        refreshing: false,
        entries: [{ ...entry, planName: name, archived: true }],
      },
    });
    expect(screen.queryByRole('list', { name: 'Unfinished plans' })).toBeNull();
    expect(
      screen.getByRole('list', { name: 'Completed and archived plans' }).textContent,
    ).toContain('Roadmap');
    expect(screen.getByRole('button', { name: 'Archive Roadmap' }).hasAttribute('disabled')).toBe(
      true,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Roadmap' })),
    );
    expect(screen.getByRole('status', { hidden: true }).classList.contains('inactive')).toBe(true);
  });

  it('renders no-workspace, loading, empty, and error catalog states', () => {
    const { rerender } = render(PlansView, {
      catalog: { kind: 'no-workspace' },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });
    expect(screen.getByText('Waiting for the application workspace…')).toBeTruthy();
    rerender({
      catalog: { kind: 'loading', workspaceId: 'one' },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });
    expect(screen.getByText('Finding Org plans…')).toBeTruthy();
    rerender({
      catalog: { kind: 'ready', workspaceId: 'one', entries: [] },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });
    expect(
      screen.getByText(
        'No .org files were found in .gestalt folders below the application workspace.',
      ),
    ).toBeTruthy();
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
    const item = screen.getByRole('button', { name: 'Open Roadmap' });
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
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Roadmap' })),
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

    expect(
      screen.getByText('Org plans in .gestalt folders below the application workspace.'),
    ).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Roadmap' }));
    expect(onopen).toHaveBeenCalledWith('plans/releases/roadmap.org');
  });

  it('lists unfinished plans before a completed section while preserving group order', () => {
    render(PlansView, {
      catalog: {
        kind: 'ready',
        workspaceId: 'one',
        entries: [
          { ...entry, planName: 'completed-one.org', title: 'Completed one', allDone: true },
          { ...entry, planName: 'active-one.org', title: 'Active one' },
          { ...entry, planName: 'completed-two.org', title: 'Completed two', allDone: true },
          {
            planName: 'notes.org',
            title: 'Notes',
            previewAvailable: false,
          },
        ],
      },
      state: null,
      onopen: vi.fn(),
      onclose: vi.fn(),
    });

    expect(screen.getByRole('list', { name: 'Unfinished plans' }).textContent).toContain(
      'Active one',
    );
    expect(screen.getByRole('list', { name: 'Unfinished plans' }).textContent).toContain('Notes');
    expect(screen.getByRole('heading', { name: 'Completed and archived', level: 3 })).toBeTruthy();
    expect(
      screen.getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent),
    ).toEqual(['Active one', 'Notes', 'Completed one', 'Completed two']);
  });

  it('opens a raw source preview for Org files outside the supervised-plan dialect', async () => {
    const onopen = vi.fn();
    const { rerender } = render(PlansView, {
      catalog: {
        kind: 'ready',
        workspaceId: 'one',
        entries: [
          {
            planName: 'notes/free-form.org',
            title: 'Free-form notes',
            previewAvailable: false,
          },
        ],
      },
      state: null,
      onopen,
      onclose: vi.fn(),
    });

    expect(screen.getByText('Free-form notes')).toBeTruthy();
    expect(screen.getByText('free-form.org')).toBeTruthy();
    const open = screen.getByRole('button', {
      name: 'Open Free-form notes',
    });
    await fireEvent.click(open);
    expect(onopen).toHaveBeenCalledWith('notes/free-form.org');

    rerender({
      catalog: {
        kind: 'ready',
        workspaceId: 'one',
        entries: [
          {
            planName: 'notes/free-form.org',
            title: 'Free-form notes',
            previewAvailable: false,
          },
        ],
      },
      state: {
        kind: 'org-source',
        planName: 'notes/free-form.org',
        title: 'Free-form notes',
        source:
          '#+TITLE: Free-form notes\n#+DATE: 2026-08-22\n\n* WIP [#A] Notes\n- Goal :: Render this document clearly.',
      },
      onopen,
      onclose: vi.fn(),
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
    expect(screen.getByText('WIP')).toBeTruthy();
    expect(screen.getByText('Render this document clearly.')).toBeTruthy();
    expect(screen.getByText('2026-08-22')).toBeTruthy();
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
