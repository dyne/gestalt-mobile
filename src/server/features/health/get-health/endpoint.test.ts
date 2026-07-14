import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type AppDependencies } from '../../../app.js';

const health = {
  async read() {
    return {
      status: 'ok' as const,
      version: '0.1.0',
      codex: { installedVersion: 'codex-cli 0.144.3', protocolVersion: null, compatible: false },
    };
  },
};

const deps: AppDependencies = { health, logger: console };

describe('GET /health', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it('returns the relay health representation', async () => {
    const app = await buildApp(deps);
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(await health.read());
  });

  it('serves the SPA fallback but leaves unknown API paths as problem documents', async () => {
    const staticDir = await mkdtemp(join(tmpdir(), 'codex-relay-static-'));
    directories.push(staticDir);
    await writeFile(join(staticDir, 'index.html'), '<h1>Relay</h1>');
    const app = await buildApp(Object.assign({}, deps, { staticDir }) as AppDependencies);
    apps.push(app);

    const page = await app.inject({ method: 'GET', url: '/sessions/example' });
    const missingApi = await app.inject({ method: 'GET', url: '/api/missing' });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Relay');
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.headers['content-type']).toContain('application/problem+json');
  });
});
