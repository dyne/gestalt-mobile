/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import WorkDetails from './WorkDetails.svelte';

describe('WorkDetails', () => {
  afterEach(cleanup);

  it('keeps commands, activity, and consolidated changed files in one closed disclosure', async () => {
    render(WorkDetails, {
      now: Date.parse('2026-08-30T12:00:05Z'),
      activities: [
        { id: 'ok', label: 'Command · completed', detail: 'npm test' },
        { id: 'failed', label: 'Command · failed', detail: 'npm run lint' },
        { id: 'tool', label: 'Tool · completed', detail: 'browser check' },
        {
          id: 'first',
          label: 'File change · completed',
          detail: 'src/a.ts',
          occurredAt: Date.parse('2026-08-30T12:00:01Z'),
          changes: [{ path: 'src/a.ts', additions: 2, deletions: 1 }],
        },
        {
          id: 'again',
          label: 'File change · completed',
          detail: 'src/a.ts',
          occurredAt: Date.parse('2026-08-30T12:00:04Z'),
          changes: [{ path: 'src/a.ts', additions: 3, deletions: 2 }],
        },
      ],
    });

    const details = screen.getByText(/Work details · 5 activities/).closest('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.hasAttribute('open')).toBe(false);
    await fireEvent.click(screen.getByText(/Work details · 5 activities/));
    expect(screen.getByText('browser check')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Files changed' }).textContent).toContain('+5');
    expect(screen.getByRole('region', { name: 'Files changed' }).textContent).toContain('-3');
    expect(details?.open).toBe(true);
  });
});
