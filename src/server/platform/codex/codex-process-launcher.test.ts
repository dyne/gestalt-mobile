/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { codexChildEnvironment, launchCodexAppServer } from './codex-process-launcher.js';
import { profileAppServerCommand } from '../catalog/profile-command.js';

vi.mock('../catalog/profile-command.js', () => ({ profileAppServerCommand: vi.fn() }));

const inheritedCapabilities = process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
const inheritedPlanStatus = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
const inheritedPlanStatusDirectory = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;

afterEach(() => {
  if (inheritedCapabilities === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
  else process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES = inheritedCapabilities;
  if (inheritedPlanStatus === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = inheritedPlanStatus;
  if (inheritedPlanStatusDirectory === undefined)
    delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = inheritedPlanStatusDirectory;
});

describe('codexChildEnvironment', () => {
  it('does not pass an ambient plan status path to catalog or model discovery children', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES = 'spoofed';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_CAPABILITIES');
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = '/ambient/session';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_FILE');
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY');
  });

  it('scrubs capability assertions from fixed native launch environments too', () => {
    expect(
      codexChildEnvironment(undefined, {
        PATH: '/trusted',
        GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'untrusted',
      }),
    ).toEqual({ PATH: '/trusted' });
    expect(
      codexChildEnvironment(
        { GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'suspension-v1' },
        { PATH: '/trusted', GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'untrusted' },
      ),
    ).toEqual({ PATH: '/trusted', GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'suspension-v1' });
  });

  it('merges only the explicit session runtime path while retaining other inherited values', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    const environment = codexChildEnvironment({
      GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY: '/private/session',
    });
    expect(environment.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY).toBe('/private/session');
    expect(environment.PATH).toBe(process.env.PATH);
  });
});

describe('app-server process lifecycle', () => {
  async function fixture(mode: string, manager?: string) {
    const root = await mkdtemp(join(tmpdir(), 'mobile-codex-lifecycle-'));
    const native = join(root, 'native.mjs');
    await writeFile(
      native,
      `#!${process.execPath}
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid));
const mode = ${JSON.stringify(mode)};
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'blocked-read') {
  process.on('SIGTERM', () => process.exit(143));
}
const input = mode === 'blocked-read' ? createReadStream(null, {fd: 0}) : process.stdin;
createInterface({input}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'hang') return;
  if (mode === 'noisy') process.stderr.write('diagnostic\\n'.repeat(100000));
  process.stdout.write(JSON.stringify({id: request.id, result: {ready: true}}) + '\\n');
  if (mode === 'early-exit') setImmediate(() => process.exit(7));
});
`,
      { mode: 0o755 },
    );
    vi.mocked(profileAppServerCommand).mockReturnValue({
      command: manager ? 'bash' : process.execPath,
      args: manager ? [manager, '__codex-app-server', native, '--stdio'] : [native],
    });
    const server = launchCodexAppServer({ profile: '', cwd: root });
    const exit = once(server.child, 'exit');
    const cleanup = async () => {
      if (server.child.exitCode === null && server.child.signalCode === null)
        server.child.kill('SIGKILL');
      await exit;
      if (manager) {
        const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    };
    return {
      server,
      exit,
      cleanup,
      nativePid: async () => Number(await readFile(join(root, 'pid'), 'utf8')),
    };
  }

  it('releases blocked filesystem readers and makes repeated close harmless', async () => {
    for (let i = 0; i < 20; i++) {
      const { server, exit, cleanup } = await fixture('blocked-read');
      try {
        await expect(server.rpc.request('initialize', {})).resolves.toEqual({ ready: true });
        server.close();
        server.close();
        await expect(exit).resolves.toEqual([143, null]);
        expect(server.child.stdin.writableEnded).toBe(true);
      } finally {
        await cleanup();
      }
    }
  });

  it('force kills an initialized child that ignores EOF and SIGTERM', async () => {
    const { server, exit, cleanup } = await fixture('stubborn');
    try {
      await server.rpc.request('initialize', {});
      server.close();
      await expect(exit).resolves.toEqual([null, 'SIGKILL']);
    } finally {
      await cleanup();
    }
  }, 6_000);

  it('settles outstanding RPCs when the native process exits', async () => {
    const { server, exit, cleanup } = await fixture('early-exit');
    try {
      await server.rpc.request('initialize', {});
      const pending = expect(server.rpc.request('hang', {})).rejects.toThrow(
        'CODEX_APP_SERVER_EXITED',
      );
      await pending;
      await expect(exit).resolves.toEqual([7, null]);
      server.close();
    } finally {
      await cleanup();
    }
  });

  it('rejects pending and future RPCs when explicitly closed', async () => {
    const { server, exit, cleanup } = await fixture('normal');
    try {
      await server.rpc.request('initialize', {});
      const pending = expect(server.rpc.request('hang', {})).rejects.toThrow(
        'CODEX_APP_SERVER_CLOSED',
      );
      server.close();
      await pending;
      await expect(server.rpc.request('after-close', {})).rejects.toThrow(
        'CODEX_APP_SERVER_CLOSED',
      );
      await exit;
    } finally {
      await cleanup();
    }
  });

  it('drains diagnostics so a full stderr pipe cannot block an RPC or shutdown', async () => {
    const { server, exit, cleanup } = await fixture('noisy');
    try {
      await expect(server.rpc.request('initialize', {})).resolves.toEqual({ ready: true });
      server.close();
      await exit;
    } finally {
      await cleanup();
    }
  });

  // Point this at a manager checkout to verify the two production boundaries
  // together, in addition to the standalone legacy-proxy regression above.
  it.runIf(Boolean(process.env.GESTALT_TEST_MANAGER_BIN))(
    'closes repeated readers through the real managed app-server wrapper',
    async () => {
      for (let i = 0; i < 20; i++) {
        const { server, exit, cleanup, nativePid } = await fixture(
          'normal',
          process.env.GESTALT_TEST_MANAGER_BIN,
        );
        try {
          await server.rpc.request('initialize', {});
          const pid = await nativePid();
          server.close();
          await exit;
          expect(server.child.stdin.writableEnded).toBe(true);
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        } finally {
          await cleanup();
        }
      }
    },
  );
});
