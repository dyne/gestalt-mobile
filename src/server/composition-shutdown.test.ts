/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { composeRelayApp } from './composition.js';
import { installShutdownHandlers } from './cli.js';

it.each([
  ['active', 'Quit'],
  ['active', 'SIGINT'],
  ['active', 'SIGTERM'],
  ['stopped', 'Quit'],
  ['stopped', 'SIGINT'],
  ['stopped', 'SIGTERM'],
] as const)('shuts down with a stalled %s history read through %s', async (state, action) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-shutdown-'));
  const root = join(directory, 'workspaces');
  const dataDir = join(directory, 'state');
  await mkdir(join(root, 'workspace'), { recursive: true });
  const closed = Promise.withResolvers<void>();
  const pending = new Set<(error: Error) => void>();
  let closing = false;
  let history: Promise<Response> | undefined;
  const app = await composeRelayApp({
    root,
    dataDir,
    homeDirectory: join(directory, 'home'),
    relyingParty: {
      publicOrigin: 'http://localhost:3000',
      rpId: 'localhost',
      rpName: 'Gestalt Mobile',
    },
    passkeyAuthEnabled: false,
    testRunnerEnabled: false,
    installedCodexVersion: 'fixture',
    startAppServers: true,
    profiles: {
      list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
      require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
    },
    launchAppServer: () => {
      const owned = new Set<(error: Error) => void>();
      const close = () => {
        for (const reject of owned) {
          reject(new Error('CODEX_APP_SERVER_CLOSED'));
          pending.delete(reject);
        }
        owned.clear();
      };
      return {
        rpc: {
          request: async (method, params) => {
            if (method === 'model/list') return { data: [{ id: 'fixture' }] };
            if (method === 'skills/list')
              return {
                data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
              };
            if (method === 'thread/start') return { thread: { id: 'durable-thread' } };
            if (method === 'thread/read') {
              if ((params as { includeTurns?: boolean }).includeTurns) {
                return new Promise((_, reject) => {
                  owned.add(reject);
                  pending.add(reject);
                });
              }
              return { thread: { id: 'durable-thread', status: { type: 'idle' }, turns: [] } };
            }
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close,
        closeAndWait: async () => close(),
        onExit: () => () => {},
      };
    },
  });
  app.addHook('onClose', async () => closed.resolve());
  const signals = new EventEmitter();
  const shutdown = installShutdownHandlers(
    app,
    signals as unknown as Pick<NodeJS.Process, 'once' | 'removeListener'>,
  );
  try {
    const workspace = (await app.inject('/api/bootstrap'))
      .json()
      .workspaces[0].children.find((item: { name: string }) => item.name === 'workspace');
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'http://localhost:3000' },
      payload: { workspaceId: workspace.id, profile: 'default', provider: 'codex' },
    });
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().id as string;
    if (state === 'stopped')
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/sessions/${id}/stop`,
            headers: { origin: 'http://localhost:3000' },
          })
        ).statusCode,
      ).toBe(202);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    // A real HTTP connection is required: inject() does not make server.close()
    // wait for the request socket, and therefore cannot reproduce this deadlock.
    history = fetch(`${address}/api/sessions/${id}/history`, { headers: { connection: 'close' } });
    await vi.waitFor(() => expect(pending.size).toBe(1));
    if (action === 'Quit') {
      const quit = await fetch(`${address}/api/maintenance/quit`, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', connection: 'close' },
      });
      expect(quit.status).toBe(202);
      await quit.json();
    } else signals.emit(action);
    void closed.promise.then(() => {
      closing = true;
    });
    await vi.waitFor(() => expect(closing).toBe(true), { timeout: 1500 });
    expect((await history).status).toBe(502);
    expect(pending.size).toBe(0);
    const database = new DatabaseSync(join(dataDir, 'relay.sqlite'), { readOnly: true });
    try {
      expect(database.prepare('SELECT thread_id FROM relay_sessions WHERE id = ?').get(id)).toEqual(
        {
          thread_id: 'durable-thread',
        },
      );
    } finally {
      database.close();
    }
  } finally {
    // A failing candidate must still release the injected blocked operation so
    // the test never leaves an HTTP listener or provider promise behind.
    for (const reject of pending) reject(new Error('fixture cleanup'));
    pending.clear();
    await history?.then((response) => response.arrayBuffer()).catch(() => undefined);
    await shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
