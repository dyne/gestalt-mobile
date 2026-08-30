/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import ActivityList from './ActivityList.svelte';

describe('ActivityList', () => {
  afterEach(cleanup);

  it('replaces command details with successful and failed counters', () => {
    render(ActivityList, {
      variant: 'live',
      activities: [
        { id: 'one', label: 'Command · completed', detail: 'npm test' },
        { id: 'two', label: 'Command · completed', detail: 'npm run build' },
        { id: 'three', label: 'Command · failed', detail: 'npm run lint' },
        { id: 'four', label: 'Command · inProgress', detail: 'npm install' },
      ],
    });

    const results = screen.getByText('Successful commands').closest('dl');
    expect(results).not.toBeNull();
    expect(results!.querySelector('[data-command-outcome="successful"] dd')?.textContent).toBe('2');
    expect(results!.querySelector('[data-command-outcome="failed"] dd')?.textContent).toBe('1');
    expect(screen.queryByText('npm test')).toBeNull();
    expect(screen.queryByText('npm run lint')).toBeNull();
    expect(screen.queryByText('npm install')).toBeNull();
  });

  it('retains non-command activity content alongside the command counters', () => {
    render(ActivityList, {
      variant: 'live',
      activities: [
        { id: 'command', label: 'Command · completed', detail: 'git status' },
        { id: 'tool', label: 'Tool · completed', detail: 'functions.view_image' },
      ],
    });

    expect(screen.getByText('functions.view_image')).not.toBeNull();
    expect(screen.queryByText('git status')).toBeNull();
  });
});
