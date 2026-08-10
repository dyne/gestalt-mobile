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
  | { kind: 'enrollment'; publicOrigin: string }
  | { kind: 'authenticated'; passkeyAuthEnabled: boolean }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string };

type ErrorDetails = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
};

function details(error: unknown): ErrorDetails {
  return typeof error === 'object' && error !== null ? (error as ErrorDetails) : {};
}

export function webAuthnMessage(error: unknown): string {
  const failure = details(error);
  const code = typeof failure.code === 'string' ? failure.code : '';
  switch (code) {
    case 'ERROR_CEREMONY_ABORTED':
      return 'The passkey request was cancelled. You can safely try again.';
    case 'ERROR_INVALID_DOMAIN':
    case 'ERROR_INVALID_RP_ID':
      return 'The passkey provider rejected this site’s domain identity. Open the canonical HTTPS address and try again.';
    case 'ERROR_INVALID_USER_ID_LENGTH':
    case 'ERROR_MALFORMED_PUBKEYCREDPARAMS':
      return `The relay supplied passkey options this browser could not use (${code}).`;
    case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      return 'This passkey provider does not support the discoverable credential required for sign-in. Try another passkey provider or browser.';
    case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
    case 'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE':
      return 'This passkey provider could not perform the required screen-lock verification. Check the device screen lock or try another provider.';
    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
      return 'This passkey is already registered on this device. Try signing in instead.';
    case 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG':
      return 'This passkey provider supports none of the relay’s allowed cryptographic algorithms. Try another provider or browser.';
    case 'ERROR_AUTHENTICATOR_GENERAL_ERROR':
      return 'The phone’s passkey provider accepted device verification but could not create the credential (ERROR_AUTHENTICATOR_GENERAL_ERROR). Try another browser or passkey provider on this phone.';
    case 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY':
      return webAuthnMessage(failure.cause);
  }

  const message = typeof failure.message === 'string' ? failure.message : '';
  switch (message) {
    case 'INVALID_REGISTRATION_REQUEST':
      return 'The relay did not understand the passkey response from this browser. Refresh the page and try again.';
    case 'REGISTRATION_COOKIE_MISSING':
      return 'The registration session cookie was not returned by this browser. Allow site cookies, refresh, and try again.';
    case 'REGISTRATION_NOT_AVAILABLE':
      return 'This registration attempt expired or is no longer available. Refresh the page and start again.';
    case 'REGISTRATION_VERIFICATION_FAILED':
      return 'Your device created the passkey, but the relay could not verify it. Try again and check the relay diagnostics if it persists.';
    case 'ORIGIN_NOT_ALLOWED':
      return 'This page is not using the relay’s configured public address. Open the canonical HTTPS address and try again.';
    case 'ENROLLMENT_NOT_AUTHORIZED':
      return 'This relay is no longer accepting first-device registration.';
    case 'AUTHENTICATION_FAILED':
      return 'We could not complete sign-in. Please try again.';
  }
  const name = typeof failure.name === 'string' ? failure.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'The passkey request was cancelled or timed out. Try again when ready.';
    case 'InvalidStateError':
      return 'This passkey is already registered on this device. Try signing in instead.';
    case 'AbortError':
      return 'The passkey request was cancelled. You can safely try again.';
    case 'SecurityError':
      return 'Passkeys require this device to use the configured secure site.';
    case 'ConstraintError':
    case 'DataError':
    case 'EncodingError':
      return 'This browser could not use the passkey options supplied by the relay. Refresh the page and try again.';
    case 'NetworkError':
      return 'The connection was interrupted while completing the passkey request. Check the connection and try again.';
    case 'OperationError':
    case 'UnknownError':
      return 'This browser or passkey provider could not finish the passkey request after device verification. Try again or use another browser on this device.';
    case 'TypeError':
      return 'This browser rejected the passkey request data. Refresh the page and try again.';
    default:
      return /^[A-Za-z]+Error$/.test(name)
        ? `The passkey request failed inside this browser (${name}). Try another browser or passkey provider on this device.`
        : 'We could not complete authentication. Please try again.';
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
  async function check(enrollmentTicket?: string): Promise<AuthState> {
    setState({ kind: 'checking' });
    try {
      const { status, publicOrigin, passkeyAuthEnabled = true } = await client.status();
      if (!passkeyAuthEnabled) {
        const next: AuthState = { kind: 'authenticated', passkeyAuthEnabled: false };
        setState(next);
        return next;
      }
      if (!browserSupportsPasskeys()) {
        const next: AuthState = {
          kind: 'unsupported',
          message: 'Passkeys require a secure browser on this device.',
        };
        setState(next);
        return next;
      }
      const next: AuthState =
        status === 'authenticated'
          ? { kind: 'authenticated', passkeyAuthEnabled: true }
          : status === 'bootstrap'
            ? { kind: 'bootstrap', publicOrigin }
            : enrollmentTicket
              ? { kind: 'enrollment', publicOrigin }
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
    setState({ kind: 'authenticated', passkeyAuthEnabled: true });
  }
  function locked(message?: string): void {
    setState({ kind: 'locked', ...(message ? { message } : {}) });
  }
  return { check, retry: check, authenticated, locked };
}
