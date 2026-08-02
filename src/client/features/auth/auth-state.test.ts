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
    const status = vi.fn();
    const states: AuthState[] = [];
    const machine = createAuthStateMachine({ status } as never, (state) => states.push(state));
    await machine.check();
    expect(states).toEqual([
      { kind: 'checking' },
      { kind: 'unsupported', message: 'Passkeys require a secure browser on this device.' },
    ]);
    expect(status).not.toHaveBeenCalled();
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

  it('moves an established session to authenticated and can lock it after expiry', () => {
    const states: AuthState[] = [];
    const machine = createAuthStateMachine(client('locked'), (state) => states.push(state));
    machine.authenticated();
    machine.locked('Your session ended.');
    expect(states).toEqual([
      { kind: 'authenticated' },
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
    ['UnknownError', 'We could not complete authentication. Please try again.'],
  ])('maps %s calmly', (name, expected) => {
    expect(webAuthnMessage(Object.assign(new Error('detail'), { name }))).toBe(expected);
  });
});
