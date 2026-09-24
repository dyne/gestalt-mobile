/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { KimiWebClient } from './kimi-web-client.js';
import { KimiWebError } from './kimi-errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('KimiWebClient', () => {
  it('unwraps successful envelopes and returns the data payload', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new KimiWebClient('http://127.0.0.1:1', 'token', async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return jsonResponse({ code: 0, msg: 'success', data: { id: 'session_x' }, request_id: 'r1' });
    });
    const data = await client.post<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: '/tmp' },
    });
    expect(data.id).toBe('session_x');
    expect(calls[0].url).toBe('http://127.0.0.1:1/api/v1/sessions');
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer token' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ metadata: { cwd: '/tmp' } });
  });

  it('throws KimiWebError with the business code on non-zero codes', async () => {
    const client = new KimiWebClient('http://127.0.0.1:1', 'token', async () =>
      jsonResponse({ code: 40401, msg: 'session not found', data: null, request_id: 'r9' }),
    );
    const error = await client.get('/api/v1/sessions/session_x').then(
      () => null,
      (reason) => reason,
    );
    expect(error).toBeInstanceOf(KimiWebError);
    expect((error as KimiWebError).code).toBe(40401);
    expect((error as KimiWebError).requestId).toBe('r9');
  });

  it('redacts secrets and caps wire messages in thrown errors', async () => {
    const longMessage = `authorization: supersecretvalue api_key= alsosecret ${'x'.repeat(400)}`;
    const client = new KimiWebClient('http://127.0.0.1:1', 'token', async () =>
      jsonResponse({ code: 40101, msg: longMessage, data: null, request_id: 'r2' }),
    );
    const error = (await client.get('/api/v1/meta').catch((reason) => reason)) as KimiWebError;
    expect(error.message).not.toContain('supersecretvalue');
    expect(error.message).not.toContain('alsosecret');
    expect(error.message).toContain('authorization: [REDACTED]');
    expect(error.message.length).toBeLessThanOrEqual(256);
  });

  it('normalizes transport failures and unreadable responses to code -1', async () => {
    const failing = new KimiWebClient('http://127.0.0.1:1', 'token', async () => {
      throw new Error('connection refused');
    });
    await expect(failing.get('/api/v1/meta')).rejects.toMatchObject({ code: -1 });

    const unreadable = new KimiWebClient(
      'http://127.0.0.1:1',
      'token',
      async () => new Response('<html>not json</html>', { status: 200 }),
    );
    await expect(unreadable.get('/api/v1/meta')).rejects.toMatchObject({ code: -1 });
  });
});
