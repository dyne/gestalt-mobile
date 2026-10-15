/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import type { ProductionLiveConfiguration } from './production-configuration.js';
import type { electLiveController } from './elected-controller.js';
import { captureLiveSources, type CapturedLiveSources } from './owning-source-inventory.js';
import { readLiveConfigFile } from './effective-config.js';
import { InstalledLivePolicy } from './installed-policy.js';
import { observeLiveProcess } from './process-identity.js';
import { prepareHelperControlLayout } from './helper-control-layout.js';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';
import { assertLiveNativeInstallation } from './native-contract.js';
import { validateOriginalLaunchSources } from './original-launch-sources.js';

type Election = Awaited<ReturnType<typeof electLiveController>>['election'];
export type OwningRuntimeCapture = Readonly<{
  captureId: string;
  sessionId: string;
  generation: number;
  directory: string;
  manifestPath: string;
  runtimeHome: string;
  keyPath: string;
  policyDigest: string;
  captured: CapturedLiveSources;
  baselineState: ManagedProjectSandboxState;
  projectState: ManagedProjectSandboxState;
  state: ManagedProjectSandboxState;
}>;
const kernelIdentity = (identity: ReturnType<typeof observeLiveProcess>) => ({
  pid: identity.pid,
  birth: identity.birth,
  uid: identity.uid,
  namespaces: {
    mnt: identity.namespaces.mnt,
    user: identity.namespaces.user,
    pid: identity.namespaces.pid,
  },
});

/** Private trusted-host operation. A configured expectation does not admit its
 * process: actual original RPC configuration/selection must later match and be sealed. */
export async function captureOwningRuntime(input: {
  configuration: ProductionLiveConfiguration;
  app: ProductionLiveConfiguration['apps'][number];
  session: RelaySessionSnapshot;
  election: Election;
  generation: number;
  authenticationDirectory: string;
  threadConfig: Readonly<Record<string, unknown>>;
}): Promise<OwningRuntimeCapture> {
  const { configuration: cfg, app, session } = input;
  if (!app.owningPolicy || session.provider !== 'codex' || session.workspacePath !== app.appRoot)
    throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
  // The accepted Manager original handoff has a fixed environment. Never start
  // a captured owner after silently dropping requested provider credentials.
  if (cfg.providerCredentialEnvironment.length)
    throw new Error('LIVE_CREDENTIAL_ENVIRONMENT_UNSUPPORTED');
  const policy = new InstalledLivePolicy(cfg.installation);
  policy.validateInstallation();
  assertLiveNativeInstallation(cfg.native.path);
  validateOriginalLaunchSources({
    owningHome: cfg.nativeEnvironment.CODEX_HOME,
    files: app.owningPolicy.configFiles,
    threadConfig: input.threadConfig,
  });
  const captured = captureLiveSources(
    app.appRoot,
    cfg.nativeEnvironment.CODEX_HOME,
    app.owningPolicy.instructionFiles,
  );
  for (const file of app.owningPolicy.configFiles) {
    const stat = lstatSync(file.path);
    if (
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      readLiveConfigFile(file.path).sha256 !== file.sha256
    )
      throw new Error('LIVE_CONFIG_CHANGED');
  }
  const directory = join(cfg.privateDirectory, `owner-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const runtimeHome = join(directory, 'native-worker-home');
  mkdirSync(runtimeHome, { mode: 0o700 });
  const workerConfig = join(runtimeHome, 'config.toml');
  writeFileSync(workerConfig, '[shell_environment_policy]\ninherit = "none"\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const keyPath = join(cfg.privateDirectory, 'live-policy.key');
  try {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = readLiveConfigFile(keyPath),
    keyStat = lstatSync(keyPath);
  if (
    !key.sha256 ||
    keyStat.uid !== process.getuid?.() ||
    (keyStat.mode & 0o777) !== 0o600 ||
    readFileSync(keyPath).length !== 32
  )
    throw new Error('LIVE_PRIVATE_STATE_INVALID');
  const baselineState = structuredClone(app.owningPolicy.sandboxState);
  const inside = (root: string, path: string) => {
    const tail = relative(root, path);
    return !tail || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
  };
  const configPaths = new Set(app.owningPolicy.configFiles.map((file) => file.path));
  const instructionPaths = [...new Set([...Object.keys(captured.instructions), ...configPaths])];
  const instructionAccess = (path: string): 'read' | 'deny' => {
    if (
      (!captured.instructions[path] && !configPaths.has(path)) ||
      baselineState.permissionProfile.file_system.entries.some(
        (entry) => entry.path.type === 'glob_pattern' && entry.access === 'deny',
      )
    )
      return 'deny';
    const grants = baselineState.permissionProfile.file_system.entries
      .flatMap((entry) => {
        const root =
          entry.path.type === 'path'
            ? entry.path.path
            : entry.path.type === 'special'
              ? ({ root: '/', slash_tmp: '/tmp' } as Record<string, string>)[entry.path.value.kind]
              : undefined;
        return root && inside(root, path) ? [{ root, access: entry.access }] : [];
      })
      .sort((a, b) => b.root.length - a.root.length);
    return grants[0]?.access && grants[0].access !== 'deny' ? 'read' : 'deny';
  };
  const projectState: ManagedProjectSandboxState = {
    ...baselineState,
    permissionProfile: {
      ...baselineState.permissionProfile,
      file_system: {
        ...baselineState.permissionProfile.file_system,
        entries: [
          ...baselineState.permissionProfile.file_system.entries.filter(
            (entry) =>
              entry.path.type !== 'path' ||
              ![...captured.directories, ...instructionPaths].some((path) =>
                inside(path, entry.path.type === 'path' ? entry.path.path : ''),
              ),
          ),
          ...captured.directories.map((path) => ({
            path: { type: 'path' as const, path },
            access: 'deny' as const,
          })),
          ...instructionPaths.map((path) => ({
            path: { type: 'path' as const, path },
            access: instructionAccess(path),
          })),
        ],
      },
    },
  };
  const state = prepareHelperControlLayout(app.appRoot, projectState);
  const manifestPath = join(directory, 'manifest.json');
  const gestalt = cfg.installation.packages.find((item) => item.name === 'gestalt')!;
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      profileId: app.owningPolicy.profileId,
      appRoot: app.appRoot,
      controller: kernelIdentity(observeLiveProcess(process.pid)),
      election: {
        holder: kernelIdentity(input.election.holder),
        lockFile: input.election.lockFile,
      },
      generation: { sessionId: session.id, generation: input.generation },
      owningRuntime: {
        args: ['app-server', '--stdio'],
        home: cfg.nativeEnvironment.CODEX_HOME,
        instructionFiles: app.owningPolicy.instructionFiles,
      },
      binary: { ...cfg.native, version: '0.161.0' },
      sandboxState: state,
      configFiles: [...app.owningPolicy.configFiles, readLiveConfigFile(workerConfig)],
      components: cfg.components,
      privatePaths: {
        auth: [input.authenticationDirectory, cfg.nativeEnvironment.CODEX_HOME],
        controller: [cfg.privateDirectory],
        caddy: [cfg.caddy.controllerDirectory],
        daemon: [`/tmp/codex-daemon-${process.getuid!()}`],
      },
      keyFile: keyPath,
      runtimeHome,
      environment: { PATH: '/usr/bin:/bin', HOME: runtimeHome, TMPDIR: '/tmp' },
      commands: {
        'context-mode-call': {
          executable: cfg.installation.node.path,
          sha256: cfg.installation.node.sha256,
          args: [
            join(gestalt.root, 'live-context-worker.mjs'),
            '--runtime',
            cfg.installation.runtime.root,
            '--workspace',
            app.appRoot,
          ],
          timeoutMs: 120000,
        },
      },
    }) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  await policy.bootstrapRuntime(manifestPath);
  const captureId = randomUUID();
  const reply = await policy.captureRuntime(manifestPath, captureId);
  if (typeof reply.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(reply.policyDigest))
    throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
  return Object.freeze({
    captureId,
    sessionId: session.id,
    generation: input.generation,
    directory,
    manifestPath,
    runtimeHome,
    keyPath,
    policyDigest: reply.policyDigest,
    captured,
    baselineState,
    projectState,
    state,
  });
}
