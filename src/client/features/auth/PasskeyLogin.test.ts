/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startAuthentication } = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication }));

import PasskeyLogin from './PasskeyLogin.svelte';

function props(overrides: Record<string, unknown> = {}) {
  return {
    client: {
      loginOptions: vi.fn(async () => ({ options: { challenge: 'challenge' } })),
      verifyLogin: vi.fn(async () => ({ status: 'authenticated' })),
    },
    onAuthenticated: vi.fn(),
    ...overrides,
  };
}

describe('PasskeyLogin', () => {
  beforeEach(() => {
    startAuthentication.mockReset();
    startAuthentication.mockResolvedValue({ id: 'credential' });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class {} });
  });
  afterEach(cleanup);

  it('focuses and completes only after an explicit passkey action', async () => {
    const values = props();
    render(PasskeyLogin, values as never);
    const button = screen.getByRole('button', { name: 'Sign in with a passkey' });
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
    expect(startAuthentication).not.toHaveBeenCalled();
    await fireEvent.click(button);
    await vi.waitFor(() =>
      expect(values.client.verifyLogin).toHaveBeenCalledWith({ id: 'credential' }),
    );
    expect(values.onAuthenticated).toHaveBeenCalledOnce();
  });

  it('suppresses duplicate login actions', async () => {
    let resolve!: (value: { options: { challenge: string } }) => void;
    const values = props({
      client: {
        ...props().client,
        loginOptions: vi.fn(() => new Promise((done) => (resolve = done))),
      },
    });
    render(PasskeyLogin, values as never);
    const button = screen.getByRole('button', { name: 'Sign in with a passkey' });
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(values.client.loginOptions).toHaveBeenCalledOnce();
    resolve({ options: { challenge: 'challenge' } });
  });

  it.each(['NotAllowedError', 'AbortError'] as const)(
    'keeps a calm retryable response after %s',
    async (name) => {
      startAuthentication.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name }));
      render(PasskeyLogin, props() as never);
      await fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
      await vi.waitFor(() => expect(screen.getByText(/cancelled|timed out/i)).toBeTruthy());
    },
  );

  it('does not enumerate unknown credentials or server/network failures', async () => {
    const values = props({
      client: {
        ...props().client,
        verifyLogin: vi.fn(async () => {
          throw new Error('AUTH_REQUEST_FAILED_404');
        }),
      },
    });
    render(PasskeyLogin, values as never);
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    await vi.waitFor(() =>
      expect(screen.getByText('We could not complete sign-in. Please try again.')).toBeTruthy(),
    );
    expect(document.body.textContent).not.toMatch(/credential|404/i);
  });

  it('guides insecure and unsupported browsers without a sign-in action', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    render(PasskeyLogin, props() as never);
    expect(screen.getByText(/secure connection/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull();
  });
});
