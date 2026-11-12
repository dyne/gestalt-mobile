/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it, vi } from 'vitest';
import { ManagedPlaywright } from './managed-playwright.js';
import { probePlaywrightComponent } from './playwright-component.js';

it('reports the installed MCP version and detected system Chrome without claiming a tested browser', async () => {
  const adapter = new ManagedPlaywright({});
  vi.spyOn(adapter, 'check').mockResolvedValue({
    status: 'installed',
    version: '0.0.85',
    manager: '/manager',
  });
  const ready = vi.spyOn(adapter, 'ready').mockResolvedValue({
    ready: true,
    package: 'ready',
    chrome: 'ready',
    node: 'ready',
    chromeVersion: '157.0.8103.78',
  });
  expect(await probePlaywrightComponent('/workspace', {}, adapter)).toMatchObject({
    version: '0.0.85',
    status: 'ready',
    detail: expect.stringContaining('Browser session has not been tested.'),
  });
  expect(ready).toHaveBeenCalledWith('/manager', '/workspace', expect.any(Number), ['--launch']);
});

it('reports Working only after a successful browser page check', async () => {
  const adapter = new ManagedPlaywright({});
  vi.spyOn(adapter, 'check').mockResolvedValue({
    status: 'installed',
    version: '0.0.85',
    manager: '/manager',
  });
  vi.spyOn(adapter, 'ready').mockResolvedValue({
    ready: true,
    package: 'ready',
    chrome: 'ready',
    node: 'ready',
    chromeVersion: '157.0.8103.78',
    browserTest: 'passed',
    playwrightVersion: '1.66.0-alpha-2026-11-09',
  });
  expect(await probePlaywrightComponent('/workspace', {}, adapter)).toMatchObject({
    status: 'working',
    detail:
      'Playwright 1.66.0-alpha-2026-11-09; Chrome 157.0.8103.78; browser page check passed at startup.',
  });
});

it('retains installation version when Chrome is missing', async () => {
  const adapter = new ManagedPlaywright({});
  vi.spyOn(adapter, 'check').mockResolvedValue({
    status: 'installed',
    version: '0.0.85',
    manager: '/manager',
  });
  vi.spyOn(adapter, 'ready').mockResolvedValue({
    ready: false,
    package: 'ready',
    chrome: 'unavailable',
    node: 'ready',
    chromeVersion: null,
  });
  expect(await probePlaywrightComponent('/workspace', {}, adapter)).toMatchObject({
    version: '0.0.85',
    status: 'unavailable',
  });
});

it('falls back to prerequisite readiness with an older manager without claiming Working', async () => {
  const adapter = new ManagedPlaywright({});
  vi.spyOn(adapter, 'check').mockResolvedValue({
    status: 'installed',
    version: '0.0.85',
    manager: '/manager',
  });
  const ready = vi
    .spyOn(adapter, 'ready')
    .mockResolvedValueOnce({
      ready: false,
      package: 'unknown',
      chrome: 'unknown',
      node: 'unknown',
      chromeVersion: null,
    })
    .mockResolvedValueOnce({
      ready: true,
      package: 'ready',
      chrome: 'ready',
      node: 'ready',
      chromeVersion: '157.0.1',
    });
  expect(await probePlaywrightComponent('/workspace', {}, adapter)).toMatchObject({
    status: 'ready',
    version: '0.0.85',
  });
  expect(ready).toHaveBeenCalledTimes(2);
  expect(ready).toHaveBeenLastCalledWith('/manager', '/workspace', expect.any(Number));
});

it('keeps the installed version when a readiness probe fails', async () => {
  const adapter = new ManagedPlaywright({});
  vi.spyOn(adapter, 'check').mockResolvedValue({
    status: 'installed',
    version: '0.0.85',
    manager: '/manager',
  });
  vi.spyOn(adapter, 'ready').mockRejectedValue(new Error('private detail'));
  expect(await probePlaywrightComponent('/workspace', {}, adapter)).toMatchObject({
    version: '0.0.85',
    status: 'unverified',
  });
});

it('does not run doctor for an absent installation or expose failed probe diagnostics', async () => {
  const adapter = new ManagedPlaywright({});
  const check = vi.spyOn(adapter, 'check').mockResolvedValue({ status: 'absent' });
  const ready = vi.spyOn(adapter, 'ready');
  expect(await probePlaywrightComponent('/workspace', {}, adapter)).toMatchObject({
    version: null,
    status: 'unavailable',
  });
  expect(ready).not.toHaveBeenCalled();
  check.mockRejectedValue(new Error('private diagnostic'));
  const result = await probePlaywrightComponent('/workspace', {}, adapter);
  expect(result.status).toBe('unverified');
  expect(JSON.stringify(result)).not.toContain('private diagnostic');
});
