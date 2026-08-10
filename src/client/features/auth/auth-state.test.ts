/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthStateMachine, webAuthnMessage, type AuthState } from './auth-state.js';

function client(status: 'bootstrap' | 'locked' | 'authenticated') {
  return { status: vi.fn(async () => ({ status, publicOrigin: 'https://relay.test' })) } as never;
}

describe('auth state machine', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class {} });
  });

  it('moves checking to unsupported when passkeys are unavailable', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    const status = vi.fn(async () => ({ status: 'locked', publicOrigin: 'https://relay.test' }));
    const states: AuthState[] = [];
    const machine = createAuthStateMachine({ status } as never, (state) => states.push(state));
    await machine.check();
    expect(states).toEqual([
      { kind: 'checking' },
      { kind: 'unsupported', message: 'Passkeys require a secure browser on this device.' },
    ]);
    expect(status).toHaveBeenCalledOnce();
  });

  it.each(['bootstrap', 'locked', 'authenticated'] as const)(
    'moves checking to %s from status',
    async (status) => {
      const states: AuthState[] = [];
      const machine = createAuthStateMachine(client(status), (state) => states.push(state));
      await machine.check();
      expect(states).toEqual([
        { kind: 'checking' },
        status === 'bootstrap'
          ? { kind: 'bootstrap', publicOrigin: 'https://relay.test' }
          : status === 'authenticated'
            ? { kind: 'authenticated', passkeyAuthEnabled: true }
            : { kind: status },
      ]);
    },
  );

  it('reports retryable status failures and retries successfully', async () => {
    const states: AuthState[] = [];
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ status: 'locked', publicOrigin: 'https://relay.test' });
    const machine = createAuthStateMachine({ status } as never, (state) => states.push(state));
    await machine.check();
    await machine.retry();
    expect(states.at(-1)).toEqual({ kind: 'locked' });
    expect(states).toContainEqual({
      kind: 'error',
      message: 'We could not check this device. Please try again.',
    });
  });

  it('enters the relay without requiring browser passkey support when access control is disabled', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    const states: AuthState[] = [];
    const status = vi.fn(async () => ({
      status: 'authenticated',
      publicOrigin: '',
      passkeyAuthEnabled: false,
    }));
    const machine = createAuthStateMachine({ status } as never, (state) => states.push(state));

    await machine.check();

    expect(states).toEqual([
      { kind: 'checking' },
      { kind: 'authenticated', passkeyAuthEnabled: false },
    ]);
  });

  it('keeps a no-session enrollment handoff focused on registration', async () => {
    const states: AuthState[] = [];
    const machine = createAuthStateMachine(client('locked'), (state) => states.push(state));
    await machine.check('opaque-ticket');
    expect(states.at(-1)).toEqual({ kind: 'enrollment', publicOrigin: 'https://relay.test' });
  });

  it('moves an established session to authenticated and can lock it after expiry', () => {
    const states: AuthState[] = [];
    const machine = createAuthStateMachine(client('locked'), (state) => states.push(state));
    machine.authenticated();
    machine.locked('Your session ended.');
    expect(states).toEqual([
      { kind: 'authenticated', passkeyAuthEnabled: true },
      { kind: 'locked', message: 'Your session ended.' },
    ]);
  });

  it.each([
    ['NotAllowedError', 'The passkey request was cancelled or timed out. Try again when ready.'],
    [
      'InvalidStateError',
      'This passkey is already registered on this device. Try signing in instead.',
    ],
    ['AbortError', 'The passkey request was cancelled. You can safely try again.'],
    ['SecurityError', 'Passkeys require this device to use the configured secure site.'],
    [
      'UnknownError',
      'This browser or passkey provider could not finish the passkey request after device verification. Try again or use another browser on this device.',
    ],
    [
      'DataError',
      'This browser could not use the passkey options supplied by the relay. Refresh the page and try again.',
    ],
    [
      'NetworkError',
      'The connection was interrupted while completing the passkey request. Check the connection and try again.',
    ],
  ])('maps %s calmly', (name, expected) => {
    expect(webAuthnMessage(Object.assign(new Error('detail'), { name }))).toBe(expected);
  });

  it.each([
    [
      'INVALID_REGISTRATION_REQUEST',
      'The relay did not understand the passkey response from this browser. Refresh the page and try again.',
    ],
    [
      'REGISTRATION_COOKIE_MISSING',
      'The registration session cookie was not returned by this browser. Allow site cookies, refresh, and try again.',
    ],
    [
      'REGISTRATION_NOT_AVAILABLE',
      'This registration attempt expired or is no longer available. Refresh the page and start again.',
    ],
    [
      'REGISTRATION_VERIFICATION_FAILED',
      'Your device created the passkey, but the relay could not verify it. Try again and check the relay diagnostics if it persists.',
    ],
    [
      'ORIGIN_NOT_ALLOWED',
      'This page is not using the relay’s configured public address. Open the canonical HTTPS address and try again.',
    ],
  ])('maps the server problem %s to an actionable message', (code, expected) => {
    expect(webAuthnMessage(new Error(code))).toBe(expected);
  });

  it.each([
    [
      'ERROR_AUTHENTICATOR_GENERAL_ERROR',
      /accepted device verification but could not create the credential.*ERROR_AUTHENTICATOR_GENERAL_ERROR/i,
    ],
    ['ERROR_INVALID_RP_ID', /rejected this site’s domain identity/i],
    ['ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG', /cryptographic algorithms/i],
  ])('maps the SimpleWebAuthn code %s without relying on Error instanceof', (code, expected) => {
    expect(webAuthnMessage({ code })).toMatch(expected);
  });

  it('maps a passthrough SimpleWebAuthn error from its DOM exception cause', () => {
    expect(
      webAuthnMessage({
        code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
        cause: { name: 'NotAllowedError' },
      }),
    ).toBe('The passkey request was cancelled or timed out. Try again when ready.');
  });

  it('reports a safe raw DOM exception name even when it is not an Error instance', () => {
    expect(webAuthnMessage({ name: 'NotReadableError' })).toBe(
      'The passkey request failed inside this browser (NotReadableError). Try another browser or passkey provider on this device.',
    );
  });
});
