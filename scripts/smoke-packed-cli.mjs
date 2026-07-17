/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer } from 'node:net';

const root = process.cwd();
const expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'gestalt-mobile-package-'));
let server;

try {
  run('npm', ['run', 'build'], root);
  const pack = run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot],
    root,
    true,
  );
  const [{ filename }] = JSON.parse(pack.stdout);
  const tarball = join(temporaryRoot, filename);
  const installation = join(temporaryRoot, 'installation');
  const workspace = join(temporaryRoot, 'workspace');
  const dataDir = join(temporaryRoot, 'state');
  const fakeBin = join(temporaryRoot, 'bin');
  await Promise.all([mkdir(installation), mkdir(workspace), mkdir(dataDir), mkdir(fakeBin)]);
  await writeFile(join(installation, 'package.json'), '{"private":true}');
  const codex = join(fakeBin, 'codex');
  await writeFile(codex, '#!/usr/bin/env node\nconsole.log("codex-cli 0.144.3");\n');
  await chmod(codex, 0o755);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], installation);

  const environment = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` };
  const help = run(
    'npm',
    ['exec', '--', 'gestalt-mobile', '--help'],
    installation,
    true,
    environment,
  );
  assert(help.stdout.includes('Usage: gestalt-mobile'), 'packed --help did not print usage');
  const version = run(
    'npm',
    ['exec', '--', 'gestalt-mobile', '--version'],
    installation,
    true,
    environment,
  );
  assert(
    version.stdout.trim() === expectedVersion,
    `packed --version did not print ${expectedVersion}`,
  );

  const port = await unusedPort();
  server = spawn(
    join(installation, 'node_modules', '.bin', 'gestalt-mobile'),
    ['--cwd', workspace, '--data-dir', dataDir, '--host', '127.0.0.1', '--port', String(port)],
    { cwd: installation, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverOutput = '';
  server.stdout.on('data', (chunk) => (serverOutput += chunk.toString()));
  server.stderr.on('data', (chunk) => (serverOutput += chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/health`, () => serverOutput);
  const client = await (await fetch(baseUrl)).text();
  assert(
    client.includes('src="/assets/') && !client.includes('/src/client/main.ts'),
    'packed client document was not served',
  );

  server.kill('SIGTERM');
  const exit = await waitForExit(server, 10_000);
  assert(
    exit.code === 0 && exit.signal === null,
    `packed server did not exit cleanly: ${serverOutput}`,
  );
  server = undefined;
  console.log('Packed Gestalt Mobile CLI smoke test passed');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await waitForExit(server, 5_000).catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd, capture = false, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr ?? ''}`,
    );
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(url, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`packed server did not become ready: ${output()}`);
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for packed server exit')),
      timeout,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
