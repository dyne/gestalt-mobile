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
    reason: 'missingDependency',
    summary: 'A dependency is unavailable.',
    requestedAction: 'Restore it.',
    resumeCondition: 'dependencyInstalled',
  },
};
describe('AutopilotAttention', () => {
  it('explains a compact blocker in the alert and sends recovery guidance', async () => {
    const onresolve = vi.fn();
    render(AutopilotAttention, {
      attention: {
        ...attention,
        supervisorReport:
          'The checkpoint cannot identify L1.2. Refresh the plan state before retrying.',
        attention: {
          reason: 'hardBlock',
          summary: 'Supervised execution requires human attention (hardBlock).',
          requestedAction:
            'Satisfy the externalStateChanged resume condition, then resume or disable Autopilot.',
          resumeCondition: 'externalStateChanged',
        },
      },
      onresolve,
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The checkpoint cannot identify L1.2.');
    expect(alert.textContent).not.toContain('externalStateChanged');
    expect(alert.textContent).not.toContain('hardBlock');
    await fireEvent.input(screen.getByLabelText('Optional guidance for the resumed work'), {
      target: { value: 'Refresh the plan and retry the checkpoint.' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onresolve).toHaveBeenCalledWith('resume', 'Refresh the plan and retry the checkpoint.');
  });
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

  it('labels a typed executor replacement approval explicitly', async () => {
    const onresolve = vi.fn();
    render(AutopilotAttention, {
      attention: {
        ...attention,
        attention: {
          ...attention.attention,
          reason: 'permissionRequired',
          resumeCondition: 'permissionGranted',
          executorReplacement: { canonicalTaskName: 'l4' },
        },
      },
      onresolve,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Authorize replacement' }));
    expect(onresolve).toHaveBeenCalledWith('resume');
  });
});
