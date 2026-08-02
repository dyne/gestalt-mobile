/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./RelayApp.svelte', () => import('./AppRelayLifecycleProbe.svelte'));

import App from './App.svelte';

describe('App auth gate', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function supportPasskeys(): void {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class {} });
  }

  function response(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), init);
  }

  function authenticatedStatus(): Response {
    return response({ status: 'authenticated', publicOrigin: 'https://relay.test' });
  }

  function installLifecycleProbes() {
    const close = vi.fn();
    const abort = vi.fn();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    class Socket {
      close = close;
    }
    class Controller {
      signal = {} as AbortSignal;
      abort = abort;
    }
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('AbortController', Controller);
    return { abort, clearIntervalSpy, close, removeDocumentListener, removeWindowListener };
  }

  it('does not perform protected HTTP or WebSocket work before authentication', async () => {
    supportPasskeys();
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ status: 'locked', publicOrigin: 'https://relay.test' })),
    );
    const Socket = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('WebSocket', Socket);
    render(App);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith('/api/auth/status', { credentials: 'same-origin' });
    expect(fetcher.mock.calls.map(([request]) => String(request))).not.toContain('/api/bootstrap');
    expect(Socket).not.toHaveBeenCalled();
  });

  it('locks the mounted relay immediately, tears down its live resources once, preserves durable storage, and posts logout once', async () => {
    supportPasskeys();
    const lifecycle = installLifecycleProbes();
    localStorage.setItem('gestalt-mobile.theme', 'dark');
    const clearStorage = vi.spyOn(Storage.prototype, 'clear');
    const removeStorage = vi.spyOn(Storage.prototype, 'removeItem');
    let resolveLogout!: (response: Response) => void;
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
      void init;
      const path = String(input);
      if (path === '/api/auth/status') return Promise.resolve(authenticatedStatus());
      if (path === '/api/auth/logout') return new Promise((resolve) => { resolveLogout = resolve; });
      if (path === '/api/sessions/recent-threads') return Promise.resolve(new Response(JSON.stringify([])));
      return Promise.resolve(new Response(JSON.stringify({ profiles: [] })));
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(App);
    await vi.waitFor(() => expect(view.container.querySelector('nav')).toBeTruthy());
    const lock = screen.getByRole('button', { name: 'Lock Gestalt Mobile' });
    lock.click();
    lock.click();
    expect(fetcher).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    await vi.waitFor(() => expect(view.container.querySelector('nav')).toBeNull());
    expect(view.container.querySelector('nav')).toBeNull();
    expect(localStorage.getItem('gestalt-mobile.theme')).toBe('dark');
    expect(clearStorage).not.toHaveBeenCalled();
    expect(removeStorage).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/auth/logout')).toHaveLength(1);
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(lifecycle.clearIntervalSpy).toHaveBeenCalledOnce();
    expect(lifecycle.abort).toHaveBeenCalledOnce();
    expect(lifecycle.removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(lifecycle.removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    resolveLogout(new Response(null, { status: 204 }));
  });

  it.each([
    ['an HTTP 500', () => Promise.resolve(new Response(null, { status: 500 }))],
    ['a rejected logout request', () => Promise.reject(new Error('offline'))],
  ])('keeps the app locally locked after %s', async (_case, logout) => {
    supportPasskeys();
    const lifecycle = installLifecycleProbes();
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/status') return Promise.resolve(authenticatedStatus());
      if (String(input) === '/api/auth/logout') return logout();
      return Promise.resolve(response({ profiles: [] }));
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(App);
    await vi.waitFor(() => expect(view.container.querySelector('nav')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Lock Gestalt Mobile' }));
    await vi.waitFor(() => expect(screen.getByText('Relay locked. Sign in with your passkey to continue.')).toBeTruthy());
    expect(view.container.querySelector('nav')).toBeNull();
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/auth/logout')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/auth/status')).toHaveLength(1);
  });

  it('unmounts and tears down the relay through App authorizedFetch after AUTH_REQUIRED', async () => {
    supportPasskeys();
    const lifecycle = installLifecycleProbes();
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/status') return Promise.resolve(authenticatedStatus());
      if (String(input) === '/api/probe')
        return Promise.resolve(response({ code: 'AUTH_REQUIRED' }, { status: 401 }));
      return Promise.resolve(response({ profiles: [] }));
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(App);
    await vi.waitFor(() => expect(view.container.querySelector('nav')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Trigger authorized request' }));
    await vi.waitFor(() => expect(screen.getByText('Your session ended. Sign in with your passkey to continue.')).toBeTruthy());
    expect(view.container.querySelector('nav')).toBeNull();
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(lifecycle.clearIntervalSpy).toHaveBeenCalledOnce();
    expect(lifecycle.abort).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/auth/logout')).toHaveLength(0);
  });
});
