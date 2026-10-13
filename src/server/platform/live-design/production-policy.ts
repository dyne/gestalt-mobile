/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { threadSkillConfig, type CodexSessionRuntime } from '../codex/session-runtime.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';
import {
  mergeLiveConfig,
  readLiveConfigFile,
  resolveLiveConfigFiles,
  type LiveConfigFile,
} from './effective-config.js';
import { InstalledLivePolicy } from './installed-policy.js';
import { observeLiveProcess } from './process-identity.js';
import type { ProductionLiveConfiguration } from './production-configuration.js';
import { owningPermissions } from './owning-permissions.js';
import { prepareHelperControlLayout } from './helper-control-layout.js';

type Observation = Awaited<ReturnType<CodexSessionRuntime['inspectLiveAdmission']>>;
export type PreparedProductionPolicy = {
  directory: string;
  manifestPath: string;
  bootstrapPath: string;
  keyPath: string;
  probePath: string;
  files: readonly LiveConfigFile[];
  state: ManagedProjectSandboxState;
  baselineState: ManagedProjectSandboxState;
  selection: Readonly<Record<string, unknown>>;
  modelConfig: Readonly<Record<string, unknown>>;
  digests: { policyDigest: string; configDigest: string; admissionDigest: string };
};
const json = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });

/** Owning source bytes are inventoried independently of the prepared tool surface.
 * Empty original inventories are accepted only after actual config/read plus full
 * resolved layers; additional original launch surfaces never disappear via overrides.
 */
export async function prepareProductionPolicy(input: {
  configuration: ProductionLiveConfiguration;
  source: LiveConfigFile;
  session: RelaySessionSnapshot;
  observation: Observation;
  app: ProductionLiveConfiguration['apps'][number];
  directory: string;
  authenticationDirectory: string;
}): Promise<PreparedProductionPolicy> {
  const { configuration: cfg, session, observation, app, directory } = input;
  const original = observation.configuration as { config?: Record<string, unknown> };
  const mcp = observation.mcp as { data?: unknown[]; nextCursor?: unknown };
  if (!Array.isArray(mcp?.data) || mcp.data.length || mcp.nextCursor)
    throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
  const merged = mergeLiveConfig(original.config ?? {}, observation.threadConfig);
  // v1 supports no pre-existing host delegates. The installed two Live packages
  // below are explicitly selected by the trusted host configuration, not claimed
  // to be the observed original inventory.
  const files = resolveLiveConfigFiles({
    configuration: observation.configuration,
    appRoot: app.appRoot,
    threadConfig: observation.threadConfig,
    approved: { mcpServers: {}, plugins: {} },
  });
  if (
    !isDeepStrictEqual(merged.mcp_servers ?? {}, {}) ||
    !isDeepStrictEqual(merged.plugins ?? {}, {})
  )
    throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
  const protectedPaths = [
    cfg.privateDirectory,
    input.authenticationDirectory,
    cfg.nativeEnvironment.CODEX_HOME,
    cfg.caddy.controllerDirectory,
    `/tmp/codex-daemon-${process.getuid!()}`,
  ];
  const { state: baselineState, selection } = owningPermissions({
    session,
    observation,
    appRoot: app.appRoot,
    protectedPaths,
  });
  if (observation.launchEnvironment?.codexHome !== cfg.nativeEnvironment.CODEX_HOME)
    throw new Error('LIVE_RUNTIME_ENVIRONMENT_UNVERIFIED');
  // L9 directly verifies the ACTUAL sources, including readable owner-only
  // installed defaults. Never substitute a private copy of a mutable source.
  for (const file of [input.source, ...files]) {
    const stat = lstatSync(file.path);
    if (
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      readLiveConfigFile(file.path).sha256 !== file.sha256
    )
      throw new Error('LIVE_CONFIG_CHANGED');
  }
  const policy = new InstalledLivePolicy(cfg.installation);
  policy.validateInstallation();
  const controlState = prepareHelperControlLayout(app.appRoot, baselineState);
  mkdirSync(directory, { mode: 0o700 }); // No authority key until the baseline exclusions above pass.
  const runtimeHome = join(directory, 'native-worker-home');
  mkdirSync(runtimeHome, { mode: 0o700 });
  const workerConfig = join(runtimeHome, 'config.toml');
  writeFileSync(workerConfig, '[shell_environment_policy]\ninherit = "none"\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const snapshot = join(directory, 'owning-configuration.json');
  json(snapshot, {
    launch: observation.launch,
    launchEnvironment: observation.launchEnvironment,
    configuration: observation.configuration,
    appRoot: app.appRoot,
    threadConfig: observation.threadConfig,
    skillsConfig: observation.skillsConfig,
    selection,
    files,
  });
  const keyPath = join(directory, 'policy-key');
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const probePath = join(directory, 'private-denial-probe');
  writeFileSync(probePath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const manifestPath = join(directory, 'manifest.json'),
    bootstrapPath = join(directory, 'bootstrap.json');
  const controller = observeLiveProcess(process.pid);
  const gestalt = cfg.installation.packages.find((entry) => entry.name === 'gestalt')!;
  const state: ManagedProjectSandboxState = {
    ...controlState,
    permissionProfile: {
      ...controlState.permissionProfile,
      file_system: {
        ...controlState.permissionProfile.file_system,
        entries: [
          ...controlState.permissionProfile.file_system.entries,
          { path: { type: 'path', path: '/proc' }, access: 'deny' },
        ],
      },
    },
  };
  const expectedServers = Object.fromEntries(
    ['context-mode', 'gestalt-org-plan'].map((server) => [
      server,
      {
        command: cfg.installation.node.path,
        args: [
          join(gestalt.root, 'live-mcp-proxy.mjs'),
          '--bootstrap',
          bootstrapPath,
          '--server',
          server,
        ],
        cwd: app.appRoot,
        env: {},
        default_tools_approval_mode: 'approve',
      },
    ]),
  );
  const filesystem: Record<string, unknown> = {};
  for (const entry of state.permissionProfile.file_system.entries) {
    const path =
      entry.path.type === 'path'
        ? entry.path.path
        : entry.path.type === 'glob_pattern'
          ? entry.path.pattern
          : (
              { root: ':root', minimal: ':minimal', slash_tmp: ':slash_tmp' } as Record<
                string,
                string
              >
            )[entry.path.value.kind];
    if (!path) throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
    // Materialized duplicate temp roots must agree; an effective restriction cannot be lost.
    if (Object.hasOwn(filesystem, path) && filesystem[path] !== entry.access)
      throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
    Object.defineProperty(filesystem, path, {
      value: entry.access,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (state.permissionProfile.file_system.glob_scan_max_depth !== undefined)
    filesystem.glob_scan_max_depth = state.permissionProfile.file_system.glob_scan_max_depth;
  const active = selection.activePermissionProfile as { id: string; extends?: string | null };
  const modelConfig = mergeLiveConfig(observation.threadConfig, {
    model_provider: selection.modelProvider,
    ...(selection.reasoningEffort ? { model_reasoning_effort: selection.reasoningEffort } : {}),
    mcp_servers: expectedServers,
    plugins: {},
    shell_environment_policy: { inherit: 'none', include_only: [], set: {} },
    permissions: {
      [active.id]: {
        ...(active.extends ? { extends: active.extends } : {}),
        filesystem,
        network: { enabled: false },
      },
    },
  });
  const overridePath = join(directory, 'prepared-owning-configuration.json');
  json(overridePath, {
    threadId: session.threadId,
    cwd: app.appRoot,
    model: session.model,
    config: threadSkillConfig(observation.skillsConfig, modelConfig).config,
    approvalPolicy: selection.approvalPolicy,
    activePermissionProfile: selection.activePermissionProfile,
  });
  const configs = [
    input.source,
    ...files,
    readLiveConfigFile(workerConfig),
    readLiveConfigFile(snapshot),
    readLiveConfigFile(overridePath),
  ];
  json(manifestPath, {
    schemaVersion: 1,
    profileId: String((selection.activePermissionProfile as { id: string }).id),
    appRoot: app.appRoot,
    controller: {
      pid: controller.pid,
      birth: controller.birth,
      uid: controller.uid,
      namespaces: {
        mnt: controller.namespaces.mnt,
        user: controller.namespaces.user,
        pid: controller.namespaces.pid,
      },
    },
    binary: { ...cfg.native, version: '0.161.0' },
    sandboxState: state,
    configFiles: configs,
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
  });
  json(bootstrapPath, {
    schemaVersion: 1,
    manifestPath,
    workspaceRoot: app.workspaceRoot,
    packages: cfg.installation.packages,
    runtime: cfg.installation.runtime,
    node: cfg.installation.node,
    effectiveConfig: {
      plugins: cfg.installation.packages.map(({ name, root }) => ({ name, root })),
      mcpServers: cfg.installation.packages.map(({ name, root }) =>
        name === 'context-mode'
          ? {
              name: 'context-mode',
              command: 'node',
              args: ['./start.mjs'],
              cwd: root,
              env: { CONTEXT_MODE_PLATFORM: 'codex' },
              default_tools_approval_mode: 'approve',
            }
          : {
              name: 'gestalt-org-plan',
              command: 'node',
              args: ['./org-plan-mcp.mjs'],
              cwd: root,
              env_vars: [
                'GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY',
                'GESTALT_MOBILE_ORG_PLAN_STATUS_FILE',
              ],
              default_tools_approval_mode: 'approve',
            },
      ),
      hooks: [],
      remoteMcp: [],
      executables: [],
    },
    plans: app.plans,
  });
  const digests = await policy.prepare(manifestPath, bootstrapPath, configs);
  const prepared = JSON.parse(readFileSync(join(directory, 'live-mcp-config.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  if (!isDeepStrictEqual(prepared.mcpServers, expectedServers))
    throw new Error('LIVE_CONFIG_CHANGED');

  return {
    directory,
    manifestPath,
    bootstrapPath,
    keyPath,
    probePath,
    files: configs,
    state,
    baselineState,
    selection,
    modelConfig,
    digests,
  };
}

/** Control records are distinct from model-facing screenshots/variant artifacts. */
export function helperControlPaths(appRoot: string): readonly string[] {
  return [
    'server.json',
    'roots.json',
    'app-root.json',
    'inject-journal.json',
    'sessions',
    'accept-receipts',
    'locks',
    'manual-edit-apply-transaction.json',
    'manual-edit-events.jsonl',
    'pending-manual-edits.json',
    'deferred-svelte-component-accepts.json',
  ]
    .map((path) => join(appRoot, '.impeccable/live', path))
    .concat([join(appRoot, '.impeccable-live.json'), join(appRoot, '.impeccable-live')]);
}
