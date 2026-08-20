/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AutopilotAttention from './AutopilotAttention.svelte';
afterEach(cleanup);
const attention = {
  requestId: 'r',
  turnId: 't',
  requestedAt: '2026-08-20T00:00:00Z',
  attention: {
    reason: 'hardBlock',
    summary: 'A dependency is unavailable.',
    requestedAction: 'Restore it.',
    resumeCondition: 'dependencyInstalled',
  },
};
describe('AutopilotAttention', () => {
  it('keeps a labelled persistent alert with explicit safe actions', async () => {
    const onresolve = vi.fn();
    render(AutopilotAttention, { attention, onresolve });
    expect(screen.getByRole('alert').textContent).toContain('A dependency is unavailable.');
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onresolve).toHaveBeenCalledWith('resume');
    expect(screen.getByRole('button', { name: 'Disable Autopilot' })).toBeTruthy();
  });

  it('bounds optional guidance before a resume request', async () => {
    const onresolve = vi.fn();
    render(AutopilotAttention, { attention, onresolve, controlId: 'unique-attention' });
    const input = screen.getByLabelText('Optional guidance for the resumed work');
    await fireEvent.input(input, { target: { value: 'x'.repeat(601) } });
    expect(screen.getByText('Guidance must be 600 characters or fewer.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
