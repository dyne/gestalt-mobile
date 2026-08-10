/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

export type AuthStatus = 'bootstrap' | 'locked' | 'authenticated';
export type AuthStatusResponse = {
  status: AuthStatus;
  publicOrigin: string;
  passkeyAuthEnabled?: boolean;
};
export type CeremonyOptions = {
  options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
};
export type AuthenticatedResponse = { status: 'authenticated' };

function malformed(): never {
  throw new Error('AUTH_RESPONSE_INVALID');
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let code: string | undefined;
    try {
      const value: unknown = await response.json();
      if (
        typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        typeof value.code === 'string'
      )
        code = value.code;
    } catch {
      /* A malformed error body must not hide the stable HTTP failure. */
    }
    throw new Error(code ?? `AUTH_REQUEST_FAILED_${response.status}`);
  }
  return response.json() as Promise<T>;
}

function isStatus(value: unknown): value is AuthStatusResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    ['bootstrap', 'locked', 'authenticated'].includes(
      (value as { status?: unknown }).status as string,
    ) &&
    typeof (value as { publicOrigin?: unknown }).publicOrigin === 'string' &&
    ((value as { passkeyAuthEnabled?: unknown }).passkeyAuthEnabled === undefined ||
      typeof (value as { passkeyAuthEnabled?: unknown }).passkeyAuthEnabled === 'boolean')
  );
}

function isOptions(value: unknown): value is CeremonyOptions {
  return (
    !!value &&
    typeof value === 'object' &&
    !!(value as { options?: unknown }).options &&
    typeof (value as { options: { challenge?: unknown } }).options.challenge === 'string'
  );
}

function isAuthenticated(value: unknown): value is AuthenticatedResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { status?: unknown }).status === 'authenticated'
  );
}

export function createAuthClient(fetcher: typeof fetch = fetch) {
  async function status(): Promise<AuthStatusResponse> {
    const value = await responseJson<unknown>(
      await fetcher('/api/auth/status', { credentials: 'same-origin' }),
    );
    if (!isStatus(value)) malformed();
    return value;
  }
  async function options(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<CeremonyOptions> {
    const value = await responseJson<unknown>(
      await fetcher(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!isOptions(value)) malformed();
    return value;
  }
  async function verify(
    path: string,
    body: Record<string, unknown>,
  ): Promise<AuthenticatedResponse> {
    const value = await responseJson<unknown>(
      await fetcher(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!isAuthenticated(value)) malformed();
    return value;
  }
  return {
    status,
    registrationOptions: (enrollmentTicket?: string) =>
      options('/api/auth/register/options', enrollmentTicket ? { enrollmentTicket } : {}),
    verifyRegistration: (response: RegistrationResponseJSON, nickname: string) =>
      verify('/api/auth/register/verify', { response, nickname }),
    loginOptions: () => options('/api/auth/login/options'),
    verifyLogin: (response: AuthenticationResponseJSON) =>
      verify('/api/auth/login/verify', { response }),
    logout: async (): Promise<void> => {
      const response = await fetcher('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`AUTH_REQUEST_FAILED_${response.status}`);
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
