/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ToastViewport from './ToastViewport.svelte';
import { createToastQueue } from './toast-queue.js';

afterEach(cleanup);

describe('ToastViewport', () => {
  it('announces errors assertively and other updates politely without moving focus', async () => {
    const queue = createToastQueue();
    const focusAnchor = document.body.appendChild(document.createElement('button'));
    focusAnchor.focus();
    render(ToastViewport, { queue });

    queue.enqueue({ kind: 'error', message: 'Connection failed.' });
    queue.enqueue({ kind: 'success', message: 'Draft saved.' });
    await Promise.resolve();

    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(focusAnchor);
    focusAnchor.remove();
  });

  it('caps visible messages and provides dismiss controls', async () => {
    const queue = createToastQueue();
    render(ToastViewport, { queue });
    for (let index = 1; index <= 4; index += 1)
      queue.enqueue({ kind: 'error', code: `ERROR_${index}`, message: `Failure ${index}.` });
    await Promise.resolve();

    expect(screen.getAllByRole('alert')).toHaveLength(3);
    const dismiss = screen.getAllByRole('button', { name: 'Dismiss error notification' })[0]!;
    await fireEvent.click(dismiss);
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.queryByText('Failure 2.')).toBeNull();
    expect(screen.getByText('Failure 1.')).toBeTruthy();
  });
});
