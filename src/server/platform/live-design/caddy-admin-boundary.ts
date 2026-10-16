/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnixCaddyAdmin } from './caddy-admin.js';

export type ManagedProjectSandboxState = {
  permissionProfile: {
    type: 'managed';
    file_system: {
      type: 'restricted';
      glob_scan_max_depth?: number;
      entries: readonly {
        path:
          | { type: 'path'; path: string }
          | { type: 'special'; value: { kind: string } }
          | { type: 'glob_pattern'; pattern: string };
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
  assertPrivateExclusion(inherited, directory);
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

function assertPrivateExclusion(state: ManagedProjectSandboxState, directory: string): void {
  for (const entry of state.permissionProfile.file_system.entries) {
    if (entry.path.type !== 'path' || entry.access === 'deny') continue;
    const suffix = relative(directory, entry.path.path);
    if (suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep))
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
  }
}

/** Validate effective denial after redundant child masks have been removed. */
export function privateDenialFailure(
  filesystem: ManagedProjectSandboxState['permissionProfile']['file_system'],
  path: string,
): 'private-denial-overridden' | 'private-denial-missing' | undefined {
  const inside = (root: string, candidate: string) => {
    const tail = relative(root, candidate);
    return !tail || (tail !== '..' && !tail.startsWith(`..${sep}`) && !tail.startsWith(sep));
  };
  const entries: { root: string; access: 'read' | 'write' | 'deny' }[] = [];
  for (const entry of filesystem.entries) {
    const root =
      entry.path.type === 'path'
        ? entry.path.path
        : entry.path.type === 'special'
          ? ({ root: '/', slash_tmp: '/tmp', tmpdir: '/tmp' } as Record<string, string>)[
              entry.path.value.kind
            ]
          : undefined;
    if (!root && entry.access !== 'deny') return 'private-denial-overridden';
    if (root) entries.push({ root, access: entry.access });
  }
  const ancestors = entries
    .filter((entry) => inside(entry.root, path))
    .sort((a, b) => b.root.length - a.root.length);
  const nearest = ancestors[0];
  if (
    !nearest ||
    nearest.access !== 'deny' ||
    ancestors.some((entry) => entry.root === nearest.root && entry.access !== 'deny')
  )
    return 'private-denial-missing';
  if (entries.some((entry) => entry.access !== 'deny' && inside(path, entry.root)))
    return 'private-denial-overridden';
  return undefined;
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

// With /proc explicitly denied, check the fixed aliases as well as the direct
// endpoints. The old enumerating probe remains for its original diagnostic gate.
const noProcProbe = projectProbe.replace(
  "const pids = readdirSync('/proc').filter(name => /^[0-9]+$/.test(name));",
  `readDenied('/proc/self/environ'); readDenied('/proc/self/root' + credential);
await connect('/proc/self/root' + socket);
let pids = []; try { pids = readdirSync('/proc').filter(name => /^[0-9]+$/.test(name)); } catch (e) {
  if (!['ENOENT','EACCES','EPERM','ENOTDIR'].includes(e.code)) breached = true;
}
if (pids.length) breached = true;`,
);

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
      /** Production uses the pinned native entrypoint and preserves denied procfs. */
      nativeNoProc?: boolean;
    },
  ) {}
  async verify(): Promise<{ uid: number; procPidsChecked: number }> {
    const options = this.options;
    const privateRoot = realpathSync(options.controllerDirectory);
    const state = options.effectiveSandboxState();
    assertPrivateExclusion(state, privateRoot);
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
      privateDenialFailure(state.permissionProfile.file_system, privateRoot)
    )
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    const admin = new UnixCaddyAdmin(options.socketPath);
    if ((await admin.request('GET', '/config/apps/http/servers')).status !== 200)
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    if (options.nativeNoProc && privateDenialFailure(state.permissionProfile.file_system, '/proc'))
      throw new Error('LIVE_CADDY_ADMIN_UNISOLATED');
    // Native restricted networking denies getsockname on Node socket-based stdio.
    // A private regular descriptor cannot act as a control or networking channel.
    const outputDirectory = options.nativeNoProc
      ? mkdtempSync(join(privateRoot, 'probe-'))
      : undefined;
    const outputPath = outputDirectory ? join(outputDirectory, 'result') : undefined;
    const outputFd = outputPath ? openSync(outputPath, 'wx', 0o600) : undefined;
    let result: { code: number | null; output: string };
    try {
      result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(
          options.codexExecutable,
          options.nativeNoProc
            ? [
                '--sandbox-policy-cwd',
                options.projectDirectory,
                '--permission-profile',
                JSON.stringify(state.permissionProfile),
                '--no-proc',
                '--',
                process.execPath,
                '--input-type=module',
                '-e',
                noProcProbe,
                options.socketPath,
                options.credentialPath,
              ]
            : [
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
            ...(options.nativeNoProc ? { argv0: 'codex-linux-sandbox' } : {}),
            env: options.sandboxEnvironment ?? process.env,
            stdio: ['ignore', outputFd ?? 'pipe', 'ignore'],
          },
        );
        let output = '';
        child.stdout?.on('data', (data) => {
          output += data;
          if (output.length > 4096) child.kill('SIGKILL');
        });
        const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          try {
            if (outputPath && statSync(outputPath).size > 4096) throw new Error();
            resolve({ code, output: outputPath ? readFileSync(outputPath, 'utf8') : output });
          } catch {
            reject(new Error('LIVE_CADDY_ADMIN_UNISOLATED'));
          }
        });
      });
    } finally {
      if (outputFd !== undefined) closeSync(outputFd);
      if (outputDirectory) rmSync(outputDirectory, { recursive: true, force: true });
    }
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
        (options.nativeNoProc ? proof.procPidsChecked !== 0 : proof.procPidsChecked < 1)
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
