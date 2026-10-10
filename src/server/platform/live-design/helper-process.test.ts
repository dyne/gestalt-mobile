/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';
import { ManagedHelperLauncher, OwnedLiveHelper, type HelperLauncher } from './helper-process.js';

const binary = process.env.LIVE_TEST_IMPECCABLE;
const roots: string[] = [];
const children: ChildProcess[] = [];
const helpers: OwnedLiveHelper[] = [];
async function port(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return result;
}
async function fixture(
  options: { launcher?: HelperLauncher; config?: unknown; binary?: string; native?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'owned live helper '));
  roots.push(root);
  const app = join(root, 'app with spaces');
  mkdirSync(join(app, '.impeccable/live'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"fixture","type":"module"}');
  writeFileSync(join(app, 'index.html'), '<html><body><h1>Original</h1></body></html>');
  const configPath = join(root, 'config with spaces.json');
  const config = JSON.stringify(
    options.config ?? { files: ['index.html'], insertBefore: '</body>', commentSyntax: 'html' },
  );
  writeFileSync(configPath, config);
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const policy: ManagedProjectSandboxState = {
    permissionProfile: {
      type: 'managed',
      file_system: {
        type: 'restricted',
        entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          { path: { type: 'path', path: app }, access: 'write' },
          { path: { type: 'path', path: root }, access: 'write' },
          { path: { type: 'path', path: join(root, 'private') }, access: 'deny' },
        ],
      },
      network: 'enabled',
    },
    sandboxCwd: pathToFileURL(app).href,
    useLegacyLandlock: false,
  };
  // Direct launch is a test fixture only; it is never wired to production Start.
  const launcher: HelperLauncher = options.launcher ?? {
    launch(executable, args, env) {
      calls.push({ args, env });
      const child = spawn(executable, [...args], {
        cwd: app,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      return child;
    },
  };
  const stateDirectory = join(root, 'private');
  const nativeLauncher = options.native
    ? new ManagedHelperLauncher({
        codexExecutable: process.env.LIVE_TEST_CODEX!,
        appRoot: app,
        effectivePolicy: policy,
      })
    : undefined;
  const settings = {
    appRoot: app,
    binary: options.binary ?? resolve(binary ?? process.execPath),
    stateDirectory,
    port: await port(),
    publicBaseUrl: 'https://preview.example:9443/__gestalt_live/',
    generation: 1,
    effectivePolicy: policy,
    launcher: nativeLauncher
      ? {
          launch(executable, args, env, effectivePolicy) {
            const child = nativeLauncher.launch(executable, args, env, effectivePolicy);
            children.push(child);
            let diagnostic = '';
            child.stderr!.on('data', (chunk: Buffer) => {
              if (diagnostic.length < 4096) diagnostic += chunk.toString();
            });
            child.once('exit', () => {
              if (/sandbox|bubblewrap|app-server socket/.test(diagnostic)) {
                const classification = /socket|daemon|ownership|mode/.test(diagnostic)
                  ? 'native sandbox startup ownership or socket prerequisite'
                  : /permission|Operation not permitted|denied/.test(diagnostic)
                    ? 'native sandbox permission prerequisite'
                    : 'native sandbox startup error';
                writeFileSync(
                  join(root, 'native-diagnostic.json'),
                  JSON.stringify({ classification }),
                );
              }
            });
            return child;
          },
        }
      : launcher,
    environment: {
      PATH: options.native ? process.env.PATH : '/nonexistent',
      HOME: root,
      IMPECCABLE_LIVE_COPY_AGENT: 'claude',
      IMPECCABLE_LIVE_DEBUG_EVENTS: '1',
    },
    configPath,
    startupTimeoutMs: options.native ? 15000 : 1200,
  };
  const helper = new OwnedLiveHelper(settings);
  helpers.push(helper);
  return { root, app, helper, settings, calls, config, configPath, policy, stateDirectory };
}
afterEach(async () => {
  for (const helper of helpers.splice(0)) {
    try {
      await helper.stop();
    } catch {
      /* corrupted fixture */
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owned helper admission', () => {
  it('rejects an unverified executable before launching anything', async () => {
    const f = await fixture({ binary: process.execPath });
    await expect(f.helper.start()).rejects.toThrow('LIVE_HELPER_BINARY_UNVERIFIED');
    expect(f.calls).toEqual([]);
  });
  it('rejects non-HTTPS, credentials, query strings and incorrect reserved paths', async () => {
    const f = await fixture();
    for (const publicBaseUrl of [
      'http://preview.example/__gestalt_live/',
      'https://a:b@preview.example/__gestalt_live/',
      'https://preview.example/__gestalt_live/?token=secret',
      'https://preview.example/',
    ]) {
      expect(() => new OwnedLiveHelper({ ...f.settings, publicBaseUrl })).toThrow(
        'LIVE_HELPER_CONFIG_INVALID',
      );
    }
  });
  it('native launcher refuses a policy for a different app instead of broadening it', async () => {
    const f = await fixture();
    const launcher = new ManagedHelperLauncher({
      codexExecutable: 'missing',
      appRoot: f.root,
      effectivePolicy: f.policy,
    });
    expect(() => launcher.launch(process.execPath, ['--version'], {}, f.policy)).toThrow(
      'LIVE_HELPER_PERMISSION_UNAVAILABLE',
    );
  });
});

describe.runIf(binary)('checksum-pinned real helper lifecycle', () => {
  it('starts foreground loopback helper, injects public URL, preserves config, uses chat only, and stops owned resources', async () => {
    const f = await fixture();
    await f.helper.start();
    const record = JSON.parse(readFileSync(join(f.stateDirectory, 'helper.json'), 'utf8'));
    expect(record.phase).toBe('ready');
    expect(record.helper.startTicks).toMatch(/^\d+$/);
    const html = readFileSync(join(f.app, 'index.html'), 'utf8');
    expect(html).toContain('https://preview.example:9443/__gestalt_live/live.js');
    expect(html).not.toContain('localhost');
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.config);
    expect(f.calls.map((c) => c.args[0])).toEqual(['live-server', 'live-inject', 'live-status']);
    for (const call of f.calls) {
      expect(call.env.IMPECCABLE_LIVE_COPY_AGENT).toBe('chat');
      expect(call.env.IMPECCABLE_LIVE_DEBUG_EVENTS).toBe('0');
      expect(call.args).not.toContain('--background');
    }
    expect(((await f.helper.status()) as { liveServer: unknown }).liveServer).not.toBeNull();
    await expect(f.helper.resume()).resolves.toHaveProperty('active', false);
    await f.helper.stop();
    await f.helper.stop();
    expect(readFileSync(join(f.app, 'index.html'), 'utf8')).toBe(
      '<html><body><h1>Original</h1></body></html>',
    );
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.config);
    expect(existsSync(join(f.app, '.impeccable/live/server.json'))).toBe(false);
    expect(JSON.stringify(f.helper.logs())).not.toMatch(/Token:|Original|claude|preview\.example/);
  });
  it('occupied helper port never starts helper or claims/stops an external dev server', async () => {
    const f = await fixture();
    const server = createServer();
    server.listen(f.settings.port, '127.0.0.1');
    await once(server, 'listening');
    try {
      await expect(f.helper.start()).rejects.toThrow('LIVE_HELPER_PORT_OCCUPIED');
      expect(f.calls).toEqual([]);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  it('failed injection stops only its helper and retains journal/config recovery evidence', async () => {
    const f = await fixture({
      config: { files: ['missing.html'], insertBefore: '</body>', commentSyntax: 'html' },
    });
    await expect(f.helper.start()).rejects.toThrow('LIVE_HELPER_START_FAILED');
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.config);
    expect(readFileSync(join(f.app, 'index.html'), 'utf8')).toBe(
      '<html><body><h1>Original</h1></body></html>',
    );
    expect(existsSync(join(f.app, '.impeccable/live/server.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.stateDirectory, 'helper.json'), 'utf8')).phase).toBe(
      'stopped',
    );
  });
  it('early child exit never becomes PID-only readiness and retains failed intent', async () => {
    const f = await fixture({
      launcher: {
        launch() {
          const child = spawn(process.execPath, ['-e', 'process.exit(1)'], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          children.push(child);
          return child;
        },
      },
    });
    await expect(f.helper.start()).rejects.toThrow('LIVE_HELPER_START_FAILED');
    expect(JSON.parse(readFileSync(join(f.stateDirectory, 'helper.json'), 'utf8')).phase).toBe(
      'recoveryRequired',
    );
    expect(readFileSync(join(f.app, 'index.html'), 'utf8')).not.toContain('live.js');
  });
  it('new controller reuses exact durable helper identity without launching another process', async () => {
    const f = await fixture();
    await f.helper.start();
    const count = f.calls.length;
    const restored = new OwnedLiveHelper(f.settings);
    helpers.push(restored);
    await restored.start();
    expect(f.calls.slice(count).map((call) => call.args[0])).toEqual(['live-status']);
    await restored.stop();
  });
  it('PID reuse/start-time tampering fails closed without stopping the currently listening process', async () => {
    const f = await fixture();
    await f.helper.start();
    const path = join(f.stateDirectory, 'helper.json');
    const original = readFileSync(path, 'utf8');
    const record = JSON.parse(original);
    record.helper.startTicks = '0';
    writeFileSync(path, JSON.stringify(record));
    await expect(f.helper.stop()).rejects.toThrow('LIVE_HELPER_RECOVERY_REQUIRED');
    await expect(f.helper.start()).rejects.toThrow('LIVE_HELPER_RECOVERY_REQUIRED');
    expect((await fetch(`http://127.0.0.1:${f.settings.port}/health`)).ok).toBe(true);
    writeFileSync(path, original);
    await f.helper.stop();
  });
  it('unowned stale upstream metadata is preserved without trusting, deleting or terminating its PID', async () => {
    const f = await fixture();
    const path = join(f.app, '.impeccable/live/server.json');
    const raw = JSON.stringify({
      pid: process.pid,
      port: f.settings.port,
      token: 'not-an-owned-helper',
    });
    writeFileSync(path, raw);
    await expect(f.helper.start()).rejects.toThrow('LIVE_HELPER_RECOVERY_REQUIRED');
    await f.helper.stop();
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(f.calls).toEqual([]);
  });
  it('helper crash requires explicit journal reconciliation then can restart with original configuration', async () => {
    const f = await fixture();
    await f.helper.start();
    const child = children[children.length - 3]!;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await expect(f.helper.start()).rejects.toThrow('LIVE_HELPER_RECOVERY_REQUIRED');
    await f.helper.recoverStopped();
    await f.helper.start();
    expect(((await f.helper.status()) as { liveServer: unknown }).liveServer).not.toBeNull();
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.config);
  });
  it('uses canonical complete with its source-dirty gate and never supplies --force', async () => {
    const f = await fixture();
    // Pinned session.rs append-event shape: restore a recoverable carbonize checkpoint.
    const journalRoot = join(f.app, '.impeccable/live/sessions');
    mkdirSync(journalRoot, { recursive: true });
    const journal = join(journalRoot, 'cleanup_session.jsonl');
    const entry =
      JSON.stringify({
        seq: 1,
        id: 'cleanup_session',
        type: 'carbonize_cleanup',
        ts: '2026-10-10T00:00:00Z',
        event: { id: 'cleanup_session', type: 'carbonize_cleanup', file: 'chosen.html' },
      }) + '\n';
    writeFileSync(journal, entry);
    writeFileSync(
      join(f.app, 'chosen.html'),
      '<!-- impeccable-carbonize-start cleanup_session --><h1>Chosen</h1><!-- impeccable-carbonize-end cleanup_session -->',
    );
    await f.helper.start();
    await expect(f.helper.resume('cleanup_session')).resolves.toHaveProperty('active', true);
    await expect(f.helper.complete('cleanup_session')).rejects.toThrow(
      'LIVE_HELPER_COMMAND_FAILED',
    );
    expect(readFileSync(journal, 'utf8')).toBe(entry);
    writeFileSync(join(f.app, 'chosen.html'), '<h1>Chosen</h1>');
    await expect(f.helper.complete('cleanup_session')).resolves.toHaveProperty(
      'phase',
      'completed',
    );
    expect(readFileSync(journal, 'utf8')).toContain(entry.trim());
    await expect(f.helper.complete('missing_session')).resolves.toHaveProperty('ok');
    expect(f.calls[f.calls.length - 1]!.args).toEqual(['live-complete', '--id', 'missing_session']);
    await expect(f.helper.complete('--force')).rejects.toThrow();
  });
});

describe.runIf(binary && process.env.LIVE_TEST_CODEX)(
  'actual admitted native helper execution',
  () => {
    it('runs pinned helper and injection under the unchanged effective managed policy', async () => {
      const f = await fixture({ native: true });
      try {
        await f.helper.start();
      } catch {
        const path = join(f.root, 'native-diagnostic.json');
        throw new Error(
          existsSync(path)
            ? readFileSync(path, 'utf8')
            : 'Native helper readiness failed without sandbox diagnostic',
        );
      }
      expect(((await f.helper.status()) as { liveServer: unknown }).liveServer).not.toBeNull();
      await f.helper.stop();
      expect(readFileSync(f.configPath, 'utf8')).toBe(f.config);
    }, 30000);
  },
);
