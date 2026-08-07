/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ManagedDevice = {
  id: string;
  nickname: string;
  createdAt: string;
  lastUsedAt?: string;
  current: boolean;
};
export type TicketStatus = 'none' | 'pending' | 'used' | 'expired';
export type EnrollmentTicket = { ticket: string; url: string; expiresAt: string };

async function json<T>(response: Response | Promise<Response>): Promise<T> {
  response = await response;
  if (!response.ok) {
    let code: string | undefined;
    try {
      const problem: unknown = await response.json();
      if (
        typeof problem === 'object' &&
        problem !== null &&
        'code' in problem &&
        typeof problem.code === 'string'
      )
        code = problem.code;
    } catch {
      /* A malformed error body must not hide the stable HTTP failure. */
    }
    throw new Error(code ?? `AUTH_REQUEST_FAILED_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function createDeviceClient(fetcher: typeof fetch) {
  return {
    list: () =>
      json<{ devices: ManagedDevice[] }>(
        fetcher('/api/auth/devices', { credentials: 'same-origin' }),
      ),
    rename: (id: string, nickname: string) =>
      json(
        fetcher(`/api/auth/devices/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nickname }),
        }),
      ),
    revoke: (id: string) =>
      json(
        fetcher(`/api/auth/devices/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        }),
      ),
    createTicket: () =>
      json<EnrollmentTicket>(
        fetcher('/api/auth/enrollment-tickets', { method: 'POST', credentials: 'same-origin' }),
      ),
    ticketStatus: () =>
      json<{ status: TicketStatus }>(
        fetcher('/api/auth/enrollment-tickets/current', { credentials: 'same-origin' }),
      ),
    cancelTicket: () =>
      json<{ status: TicketStatus }>(
        fetcher('/api/auth/enrollment-tickets/current', {
          method: 'DELETE',
          credentials: 'same-origin',
        }),
      ),
  };
}
export type DeviceClient = ReturnType<typeof createDeviceClient>;
