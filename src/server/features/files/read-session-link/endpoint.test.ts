/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerReadSessionLink } from './endpoint.js';

function fixture(type = 'agentMessage', text = '[Trace](/tmp/trace.json:12)') {
  const app = fastify();
  const readLinkedFile = vi.fn(async () => ({
    kind: 'available' as const,
    preview: { kind: 'file' as const, path: '/tmp/trace.json', content: '{"ok":true}', size: 11 },
  }));
  const readWorkspaceFile = vi.fn(async () => ({ kind: 'unreadable' as const }));
  registerReadSessionLink(app, {
    find: (id) => (id === 's' ? ({ id, workspacePath: '/workspace' } as never) : null),
    readHistory: async () => ({
      turns: [{ items: [{ id: 'a', type, text }], startedAt: null, completedAt: null }],
    }),
    readLinkedFile,
    readWorkspaceFile,
  });
  return { app, readLinkedFile, readWorkspaceFile };
}
describe('session linked file previews', () => {
  it('allows an outside file explicitly linked by this session assistant', async () => {
    const { app, readLinkedFile } = fixture();
    const response = await app.inject('/api/sessions/s/files/preview?path=%2Ftmp%2Ftrace.json');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'file', content: '{"ok":true}' });
    expect(readLinkedFile).toHaveBeenCalledWith('/workspace', '/tmp/trace.json');
    await app.close();
  });
  it.each(['userMessage', 'reasoning'])('does not grant outside access from %s', async (type) => {
    const { app, readLinkedFile } = fixture(type);
    expect(
      (await app.inject('/api/sessions/s/files/preview?path=%2Ftmp%2Ftrace.json')).statusCode,
    ).toBe(403);
    expect(readLinkedFile).not.toHaveBeenCalled();
    await app.close();
  });
  it('rejects unrelated files, other sessions and malformed paths', async () => {
    const { app, readLinkedFile } = fixture();
    for (const path of ['/tmp/other.json', '/tmp/trace.json/../other.json']) {
      const response = await app.inject(
        '/api/sessions/s/files/preview?' + new URLSearchParams({ path }),
      );
      expect(response.statusCode).toBe(403);
    }
    expect(
      (await app.inject('/api/sessions/other/files/preview?path=%2Ftmp%2Ftrace.json')).statusCode,
    ).toBe(404);
    for (const query of ['', '?path=%00', '?path=https://example.com/a.json', '?path=a&path=b'])
      expect((await app.inject('/api/sessions/s/files/preview' + query)).statusCode).toBe(400);
    expect(readLinkedFile).not.toHaveBeenCalled();
    await app.close();
  });
  it('keeps normal workspace previews available for Markdown navigation', async () => {
    const { app, readWorkspaceFile, readLinkedFile } = fixture();
    readWorkspaceFile.mockResolvedValueOnce({
      kind: 'available',
      preview: { kind: 'file', path: 'docs/config.json', content: '{}', size: 2 },
    } as never);
    expect(
      (await app.inject('/api/sessions/s/files/preview?path=docs/config.json')).statusCode,
    ).toBe(200);
    expect(readLinkedFile).not.toHaveBeenCalled();
    await app.close();
  });
  it('returns bounded errors for missing linked files', async () => {
    const { app, readLinkedFile } = fixture();
    readLinkedFile.mockResolvedValueOnce({ kind: 'missing' } as never);
    const response = await app.inject('/api/sessions/s/files/preview?path=%2Ftmp%2Ftrace.json');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'FILE_PREVIEW_NOT_FOUND' });
    await app.close();
  });
});
