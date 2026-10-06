/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DebugDialog from './DebugDialog.svelte';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(cleanup);
const confirmation = {
  confirmationId: 'confirmation',
  context: {
    handoffTrace: 'handoff-live',
    control: 'control-live',
    mobileSession: 'mobile-live',
    codexThread: 'codex-live',
    capturedAt: '2026-10-06T12:00:00.000Z',
    versions: [{ id: 'gestalt-mobile' as const, label: 'Mobile', version: '0.44.3' }],
  },
};

describe('Self DEBUG confirmation', () => {
  it('shows captured identifiers and versions, focuses Cancel, and creates nothing on cancel', async () => {
    const onconfirm = vi.fn();
    const onclose = vi.fn();
    render(DebugDialog, { confirmation, onconfirm, onclose });
    for (const value of ['handoff-live', 'control-live', 'mobile-live', 'codex-live', '0.44.3'])
      expect(screen.getByText(value)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onconfirm).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledOnce();
  });
  it('prevents repeated submission and cancellation while starting', async () => {
    let finish!: () => void;
    const onconfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(DebugDialog, { confirmation, onconfirm, onclose: () => {} });
    await fireEvent.click(screen.getByRole('button', { name: 'Start Self DEBUG' }));
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Preparing Self DEBUG…' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(onconfirm).toHaveBeenCalledOnce();
    finish();
  });
});
