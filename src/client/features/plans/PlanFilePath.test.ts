/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { copyText } from '../sessions/clipboard.js';
import PlanFilePath from './PlanFilePath.svelte';

vi.mock('../sessions/clipboard.js', () => ({ copyText: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it.each([true, false])(
  'copies the exact full path and reports clipboard success=%s',
  async (copied) => {
    const path = '/home/developer/Project with spaces/.gestalt/計画.org';
    vi.mocked(copyText).mockResolvedValue(copied);
    const oncopyresult = vi.fn();
    render(PlanFilePath, { path, oncopyresult });

    expect(screen.getByText(path)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Copy Org file path' }));

    expect(copyText).toHaveBeenCalledWith(path);
    await waitFor(() => expect(oncopyresult).toHaveBeenCalledWith(copied));
  },
);
