/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import InteractionList from './InteractionList.svelte';

afterEach(cleanup);

describe('InteractionList', () => {
  it('shows the command above spaced approval controls', async () => {
    const ondecision = vi.fn();
    render(InteractionList, {
      interactions: [{ requestId: 'request-1', kind: 'commandApproval', payload: { command: 'git status' } }],
      answers: {}, onanswer: () => {}, onuserinput: () => {}, onpermission: () => {}, ondecision,
    });

    expect(screen.getByText('git status').closest('.command-approval-command')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' }).parentElement?.classList.contains('approval-actions')).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(ondecision).toHaveBeenCalledWith('request-1', 'accept');
  });
});
