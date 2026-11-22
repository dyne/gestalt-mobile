/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it, vi } from 'vitest';
import { ManagedPlaywright } from './managed-playwright.js';
import { readPlaywrightComponent } from './playwright-component.js';

it('reports the installed version without running a browser readiness probe', async () => {
  const adapter = new ManagedPlaywright({});
  vi.spyOn(adapter, 'check').mockResolvedValue({
    status: 'installed',
    version: '0.0.85',
    manager: '/manager',
  });
  const ready = vi.spyOn(adapter, 'ready');
  expect(await readPlaywrightComponent({}, adapter)).toMatchObject({
    version: '0.0.85',
    status: 'unverified',
  });
  expect(ready).not.toHaveBeenCalled();
});

it('distinguishes absent installation metadata from a failed read', async () => {
  const adapter = new ManagedPlaywright({});
  const check = vi.spyOn(adapter, 'check').mockResolvedValue({ status: 'absent' });
  expect(await readPlaywrightComponent({}, adapter)).toMatchObject({
    version: null,
    status: 'unavailable',
  });
  check.mockRejectedValue(new Error('private diagnostic'));
  const result = await readPlaywrightComponent({}, adapter);
  expect(result.status).toBe('unverified');
  expect(JSON.stringify(result)).not.toContain('private diagnostic');
});
