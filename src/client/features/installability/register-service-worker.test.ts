/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { registerInstallabilityWorker } from './register-service-worker.js';

describe('installability service worker', () => {
  it('registers immediately after the page has loaded', () => {
    const register = vi.fn().mockResolvedValue(undefined);

    registerInstallabilityWorker({
      readyState: 'complete',
      addLoadListener: vi.fn(),
      serviceWorker: { register },
    });

    expect(register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
  });

  it('defers registration until the load event', () => {
    const register = vi.fn().mockResolvedValue(undefined);
    let onLoad: (() => void) | undefined;

    registerInstallabilityWorker({
      readyState: 'interactive',
      addLoadListener: (listener) => {
        onLoad = listener;
      },
      serviceWorker: { register },
    });

    expect(register).not.toHaveBeenCalled();
    onLoad?.();
    expect(register).toHaveBeenCalledOnce();
  });

  it('does nothing when service workers are unavailable', () => {
    const addLoadListener = vi.fn();

    registerInstallabilityWorker({ readyState: 'complete', addLoadListener });

    expect(addLoadListener).not.toHaveBeenCalled();
  });

  it('does not surface registration failures to the application', async () => {
    const register = vi.fn().mockRejectedValue(new Error('registration unavailable'));

    expect(() =>
      registerInstallabilityWorker({
        readyState: 'complete',
        addLoadListener: vi.fn(),
        serviceWorker: { register },
      }),
    ).not.toThrow();
    await Promise.resolve();
  });
});
