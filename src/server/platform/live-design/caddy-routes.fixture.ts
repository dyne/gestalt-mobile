/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnixCaddyAdmin } from './caddy-admin.js';

export async function freePort(): Promise<number> {
  const server = tcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
export async function realCaddyFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'gestalt-live-caddy-'));
  const controllerDirectory = join(dir, 'controller');
  await mkdir(controllerDirectory, { mode: 0o700 });
  const ports: number[] = [];
  while (ports.length < 4) {
    const port = await freePort();
    if (!ports.includes(port)) ports.push(port);
  }
  const socket = join(controllerDirectory, 'admin.sock');
  const unrelated = {
    listen: [`127.0.0.1:${ports[0]}`],
    routes: [{ handle: [{ handler: 'static_response', body: 'unrelated site preserved' }] }],
    automatic_https: { disable: true },
  };
  const baseline = {
    admin: { listen: `unix/${socket}|0600`, config: { persist: false } },
    logging: { logs: { default: { level: 'ERROR' } } },
    apps: {
      http: { servers: { unrelated } },
      tls: {
        automation: {
          policies: [{ subjects: ['preview.example.test'], issuers: [{ module: 'internal' }] }],
        },
      },
      pki: { certificate_authorities: { local: { install_trust: false } } },
    },
  };
  const config = join(controllerDirectory, 'config.json');
  const caddyfile = join(controllerDirectory, 'Caddyfile');
  await writeFile(config, JSON.stringify(baseline));
  await writeFile(
    caddyfile,
    `{
    admin unix/${socket}|0600
    persist_config off
    skip_install_trust
  }
  http://127.0.0.1:${ports[0]} {
    respond "unrelated site preserved"
  }
  `,
  );
  let child: ChildProcess;
  let diagnostic = '';
  const admin = new UnixCaddyAdmin(socket);
  async function start() {
    diagnostic = '';
    child = spawn(process.env.LIVE_TEST_CADDY ?? 'caddy', ['run', '--config', config], {
      env: {
        ...process.env,
        XDG_DATA_HOME: join(dir, 'data'),
        XDG_CONFIG_HOME: join(dir, 'state'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.on('data', (data) => {
      diagnostic = (diagnostic + data).slice(-1500);
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Caddy fixture failed: ${diagnostic}`);
      try {
        if ((await admin.request('GET', '/config/apps/http/servers')).status === 200) return;
      } catch {
        /* Waiting for owned fixture only. */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Caddy fixture startup timed out');
  }
  async function stop() {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  }
  async function raw(method: string, path: string, body?: unknown, etag?: string) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          socketPath: socket,
          agent: false,
          method,
          path,
          headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) },
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const appRoots = [join(dir, 'app one'), join(dir, 'app two'), join(dir, 'app three')];
  for (const root of appRoots) await mkdir(root);
  const gateway = createServer((_req, res) => res.end('authenticated gateway fixture'));
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === 'string')
    throw new Error('Fixture gateway missing');
  await start();
  return {
    dir,
    controllerDirectory,
    ports: ports.slice(1),
    unrelated,
    baseline,
    socket,
    admin,
    raw,
    start,
    stop,
    config,
    caddyfile,
    appRoots,
    gatewayPort: gatewayAddress.port,
    async close() {
      await stop();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
