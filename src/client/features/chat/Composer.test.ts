/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Composer from './Composer.svelte';

afterEach(cleanup);

describe('Composer', () => {
  it('separates the ready label from its cursor', () => {
    render(Composer, {
      status: 'Ready.',
      message: '',
      activeTurnId: null,
      starting: false,
      onchange: () => {},
      onsend: () => {},
      oninterrupt: () => {},
    });

    const status = screen.getByRole('status', { name: 'Ready.' });
    expect(status.firstChild?.textContent).toBe('Ready ');
  });
});
