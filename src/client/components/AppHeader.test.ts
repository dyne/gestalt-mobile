/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import AppHeader from './AppHeader.svelte';

afterEach(cleanup);

describe('AppHeader', () => {
  it('keeps the session model as separately spaced header metadata', () => {
    const { container } = render(AppHeader, {
      theme: 'system',
      sessionPath: '/workspace/gestalt-mobile',
      sessionModel: 'gpt-5.6-terra',
      onthemechange: () => {},
    });

    expect(container.querySelector('.session-model')?.textContent).toBe('· gpt-5.6-terra');
  });
});
