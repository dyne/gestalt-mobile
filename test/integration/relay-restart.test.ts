import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { composeRelayApp } from '../../src/server/composition.js';
const paths: string[] = [];
afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
function fakeAppServer(calls: string[]) {
  return {
    rpc: {
      request: async (method: string) => {
        calls.push(method);
        return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: () => {},
    onExit: () => () => {},
  };
}
test('restores a persisted thread after an HTTP relay restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
  paths.push(root, dataDir);
  await mkdir(join(root, 'workspace'));
  const profiles = {
    list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' }],
    require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
  };
  const first = await composeRelayApp({
    root,
    dataDir,
    profiles,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer: () => fakeAppServer([]),
  });
  await first.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(first.server.address() as { port: number }).port}`;
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(
    (response) => response.json() as Promise<{ workspaces: Array<{ id: string }> }>,
  );
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: bootstrap.workspaces[0]?.id, profile: 'default' }),
  }).then((response) => response.json() as Promise<{ id: string }>);
  await first.close();
  const restoredCalls: string[] = [];
  const second = await composeRelayApp({
    root,
    dataDir,
    profiles,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer: () => fakeAppServer(restoredCalls),
  });
  await second.listen({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await second.inject(`/api/sessions/${created.id}`)).json()).toMatchObject({
    threadId: 'thread-1',
    state: 'ready',
  });
  expect(restoredCalls).toEqual(['initialize', 'thread/resume']);
  await second.close();
});
