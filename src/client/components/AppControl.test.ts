/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppControl from './AppControl.svelte';

afterEach(cleanup);

describe('AppControl', () => {
  const text = (value: string) =>
    createRawSnippet(() => ({
      render: () => `<span>${value}</span>`,
    }));

  it('keeps native button behavior while applying the shared control surface', async () => {
    const onclick = vi.fn();
    render(AppControl, { children: text('Open'), onclick });

    const button = screen.getByRole('button', { name: 'Open' });
    expect(button.classList.contains('app-control')).toBe(true);
    await fireEvent.click(button);
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('keeps native disclosure semantics on the same shared control surface', () => {
    const { container } = render(AppControl, {
      children: text('Agents (1)'),
      element: 'summary',
      compact: true,
      full: true,
    });

    const summary = container.querySelector('summary');
    expect(summary?.textContent).toContain('Agents (1)');
    expect(summary?.classList.contains('app-control')).toBe(true);
    expect(summary?.classList.contains('compact')).toBe(true);
    expect(summary?.classList.contains('full')).toBe(true);
  });
});
