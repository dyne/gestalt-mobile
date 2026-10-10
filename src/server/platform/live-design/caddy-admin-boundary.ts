/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnixCaddyAdmin } from './caddy-admin.js';

export type ManagedProjectSandboxState = {
  permissionProfile: {
    type: 'managed';
    file_system: {
      type: 'restricted';
      entries: readonly {
        path: { type: 'path'; path: string } | { type: 'special'; value: { kind: string } };
        access: 'read' | 'write' | 'deny';
      }[];
    };
    network: 'enabled' | 'restricted';
  };
  sandboxCwd: string;
  useLegacyLandlock: false;
};

/** Add private-state exclusion at project admission; never widen inherited permissions. */
export function protectCaddyControllerState(
  inherited: ManagedProjectSandboxState,
  controllerDirectory: string,
): ManagedProjectSandboxState {
  const directory = realpathSync(controllerDirectory);
  return {
    ...inherited,
    permissionProfile: {
      ...inherited.permissionProfile,
      file_system: {
        ...inherited.permissionProfile.file_system,
        entries: [
          ...inherited.permissionProfile.file_system.entries,
          { path: { type: 'path', path: directory }, access: 'deny' },
        ],
      },
    },
  };
}

const projectProbe = `
import { request } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
const [socket, credential] = process.argv.slice(1);
let breached = false;
const readDenied = path => {
  try { readFileSync(path); breached = true; } catch (e) {
    if (!['ENOENT','EACCES','EPERM','ENOTDIR'].includes(e.code)) breached = true;
  }
};
async function connect(path) {
  await new Promise(resolve => {
    const req = request({ socketPath: path, path: '/config/', agent: false }, res => {
      breached = true; res.destroy(); resolve();
    });
    req.on('socket', connection => connection.once('connect', () => { breached = true; }));
    req.on('error', e => { if (!['ENOENT','EACCES','EPERM','ENOTDIR','ECONNREFUSED'].includes(e.code)) breached = true; resolve(); });
    req.setTimeout(500, () => { breached = true; req.destroy(); resolve(); }); req.end();
  });
}
readDenied(credential); await connect(socket);
const pids = readdirSync('/proc').filter(name => /^[0-9]+$/.test(name));
if (pids.length > 4096) breached = true;
for (const pid of pids.slice(0,4096)) {
  readDenied('/proc/' + pid + '/root' + credential);
  await connect('/proc/' + pid + '/root' + socket);
}
console.log(JSON.stringify({ started:true, uid:process.getuid(), denied:!breached, procPidsChecked:pids.length }));
process.exitCode = breached ? 1 : 0;
`;

/** Tests the actual admitted project policy through the native Codex sandbox, with no UID substitution. */
export class ManagedCaddyAdminBoundary {
  constructor(
    private readonly options: {
      codexExecutable: string;
      projectDirectory: string;
      controllerDirectory: string;
      socketPath: string;
      credentialPath: string;
      effectiveSandboxState(): ManagedProjectSandboxState;
      /** Controller-owned runtime environment; never copy a project env/secret into the probe. */
      sandboxEnvironment?: NodeJS.ProcessEnv;
    },
  ) {}
  async verify(): Promise<{ uid: number; procPidsChecked: number }> {
    const options = this.options;
    const privateRoot = realpathSync(options.controllerDirectory);
    const state = options.effectiveSandboxState();
    if (realpathSync(fileURLToPath(state.sandboxCwd)) !== realpathSync(options.projectDirectory))
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    for (const path of [options.socketPath, options.credentialPath]) {
      const suffix = relative(privateRoot, realpathSync(path));
      if (suffix === '..' || suffix.startsWith(`..${sep}`) || suffix.startsWith(sep))
        throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    }
    if (
      state.permissionProfile.type !== 'managed' ||
      state.permissionProfile.file_system.type !== 'restricted' ||
      state.useLegacyLandlock !== false ||
      !state.permissionProfile.file_system.entries.some(
        (entry) =>
          entry.access === 'deny' && entry.path.type === 'path' && entry.path.path === privateRoot,
      )
    )
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    const admin = new UnixCaddyAdmin(options.socketPath);
    if ((await admin.request('GET', '/config/apps/http/servers')).status !== 200)
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        options.codexExecutable,
        [
          'sandbox',
          '--sandbox-state-json',
          JSON.stringify(state),
          '--',
          process.execPath,
          '--input-type=module',
          '-e',
          projectProbe,
          options.socketPath,
          options.credentialPath,
        ],
        {
          cwd: options.projectDirectory,
          env: options.sandboxEnvironment ?? process.env,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
        if (output.length > 4096) child.kill('SIGKILL');
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve({ code, output });
      });
    });
    try {
      const proof = JSON.parse(result.output) as {
        started: unknown;
        uid: unknown;
        denied: unknown;
        procPidsChecked: unknown;
      };
      if (
        result.code !== 0 ||
        proof.started !== true ||
        proof.denied !== true ||
        proof.uid !== process.getuid?.() ||
        typeof proof.procPidsChecked !== 'number' ||
        proof.procPidsChecked < 1
      )
        throw new Error();
      if ((await admin.request('GET', '/config/apps/http/servers')).status !== 200)
        throw new Error();
      return { uid: proof.uid as number, procPidsChecked: proof.procPidsChecked };
    } catch {
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    }
  }
}
