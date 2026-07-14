import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { composeRelayApp } from './composition.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('production composition', () => {
  it('persists a catalog-selected session under the configured data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-relay-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'codex-relay-state-'));
    temporaryPaths.push(root, dataDir);
    await mkdir(join(root, 'workspace'));
    const app = await composeRelayApp({
      root,
      dataDir,
      profiles: {
        list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
        require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
      },
      installedCodexVersion: 'codex-cli 0.144.3',
    });

    const bootstrap = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    const workspace = bootstrap.json().workspaces[0];
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace.id, profile: 'default' },
    });
    expect(created.statusCode).toBe(202);
    const restored = await app.inject({ method: 'GET', url: `/api/sessions/${created.json().id}` });
    expect(restored.json()).toMatchObject({
      workspaceId: workspace.id,
      workspacePath: join(root, 'workspace'),
    });
    await app.close();
  });
});
