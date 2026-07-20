/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { createRelayClient } from './relay-client.js';

describe('relay client', () => {
  it('creates a selected session and submits a text turn through relay routes', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const client = createRelayClient(async (url, init) => {
      requests.push({ url: String(url), body: init?.body as string | undefined });
      return new Response(
        JSON.stringify({ id: String(url).includes('/turns') ? 'session-1' : 'session-1' }),
        { status: 202 },
      );
    });
    await client.startSession('workspace-1');
    await client.startTurn('session-1', 'hello');
    expect(requests).toEqual([
      {
        url: '/api/sessions',
        body: JSON.stringify({ workspaceId: 'workspace-1', profile: 'default' }),
      },
      { url: '/api/sessions/session-1/turns', body: JSON.stringify({ text: 'hello' }) },
    ]);
  });

  it('reads and pulls the selected session Git summary', async () => {
    const requests: string[] = [];
    const client = createRelayClient(async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify({ available: true }), { status: 200 });
    });
    await client.getGitSummary('session-1');
    await client.pullGit('session-1');
    expect(requests).toEqual([
      'GET /api/sessions/session-1/git',
      'POST /api/sessions/session-1/git/pull',
    ]);
  });

  it('posts a Git address and workspace destination to clone', async () => {
    let body: unknown;
    const client = createRelayClient(async (_url, init) => {
      body = init?.body;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });

    await client.cloneGitRepository('workspace-1', 'https://example.test/gestalt.git');

    expect(body).toBe(
      JSON.stringify({ workspaceId: 'workspace-1', address: 'https://example.test/gestalt.git' }),
    );
  });

  it('passes stable idempotency keys to Git mutations', async () => {
    const headers: Array<HeadersInit | undefined> = [];
    const client = createRelayClient(async (_url, init) => {
      headers.push(init?.headers);
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });

    await client.pullGit('session-1', 'pull-key');
    await client.pushGit('session-1', 'push-key');

    expect(headers).toEqual([
      { 'content-type': 'application/json', 'idempotency-key': 'pull-key' },
      { 'content-type': 'application/json', 'idempotency-key': 'push-key' },
    ]);
  });

  it('lists durable sessions', async () => {
    const requests: string[] = [];
    const client = createRelayClient(async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await client.listSessions();
    expect(requests).toEqual(['GET /api/sessions']);
  });

  it('releases a session without forgetting it', async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    const client = createRelayClient(async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method,
        body: init?.body as string | undefined,
      });
      return new Response(JSON.stringify({ state: 'released' }), { status: 202 });
    });

    await client.releaseSession('session/1');

    expect(requests).toEqual([
      {
        url: '/api/sessions/session%2F1/release',
        method: 'POST',
        body: '{}',
      },
    ]);
  });

  it('promotes a recent Codex thread into a managed session', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const client = createRelayClient(async (url, init) => {
      requests.push({ url: String(url), body: init?.body as string | undefined });
      return new Response(JSON.stringify({ id: 'session-1' }), { status: 202 });
    });

    await client.openRecentSession('thread-1', '/work/project');

    expect(requests).toEqual([
      {
        url: '/api/sessions/recent-threads/open',
        body: JSON.stringify({ threadId: 'thread-1', cwd: '/work/project' }),
      },
    ]);
  });

  it('preserves a relay problem detail for a failed mutation', async () => {
    const client = createRelayClient(
      async () =>
        new Response(
          JSON.stringify({
            title: 'Profile unavailable',
            detail: 'The selected profile is not logged in.',
            code: 'PROFILE_NOT_READY',
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    await expect(client.startSession('workspace-1')).rejects.toThrow(
      'The selected profile is not logged in.',
    );
  });

  it('submits an interaction decision to the original session request', async () => {
    const requests: string[] = [];
    const client = createRelayClient(async (url, init) => {
      requests.push(`${init?.method} ${String(url)} ${String(init?.body)}`);
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
    await client.respondInteraction('session-1', 'request-1', { decision: 'approved' });
    expect(requests).toEqual([
      'POST /api/sessions/session-1/interactions/request-1 {"decision":"approved"}',
    ]);
  });
});
