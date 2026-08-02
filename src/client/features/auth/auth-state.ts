/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AuthClient } from './auth-client.js';

export type AuthState =
  | { kind: 'checking' }
  | { kind: 'bootstrap'; publicOrigin: string }
  | { kind: 'locked'; message?: string }
  | { kind: 'authenticated' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string };

export function webAuthnMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'We could not complete authentication. Please try again.';
  switch (error.name) {
    case 'NotAllowedError':
      return 'The passkey request was cancelled or timed out. Try again when ready.';
    case 'InvalidStateError':
      return 'This passkey is already registered on this device. Try signing in instead.';
    case 'AbortError':
      return 'The passkey request was cancelled. You can safely try again.';
    case 'SecurityError':
      return 'Passkeys require this device to use the configured secure site.';
    default:
      return 'We could not complete authentication. Please try again.';
  }
}

function browserSupportsPasskeys(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential !== 'undefined'
  );
}

export function createAuthStateMachine(client: AuthClient, setState: (state: AuthState) => void) {
  async function check(): Promise<AuthState> {
    setState({ kind: 'checking' });
    if (!browserSupportsPasskeys()) {
      const next: AuthState = {
        kind: 'unsupported',
        message: 'Passkeys require a secure browser on this device.',
      };
      setState(next);
      return next;
    }
    try {
      const { status, publicOrigin } = await client.status();
      const next: AuthState =
        status === 'authenticated'
          ? { kind: 'authenticated' }
          : status === 'bootstrap'
            ? { kind: 'bootstrap', publicOrigin }
            : { kind: 'locked' };
      setState(next);
      return next;
    } catch {
      const next: AuthState = {
        kind: 'error',
        message: 'We could not check this device. Please try again.',
      };
      setState(next);
      return next;
    }
  }
  function authenticated(): void {
    setState({ kind: 'authenticated' });
  }
  function locked(message?: string): void {
    setState({ kind: 'locked', ...(message ? { message } : {}) });
  }
  return { check, retry: check, authenticated, locked };
}
