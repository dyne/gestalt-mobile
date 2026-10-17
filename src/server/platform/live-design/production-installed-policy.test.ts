/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'smol-toml';
import { prepareProductionPolicy } from './production-policy.js';
import { InstalledLivePolicy, LIVE_MANAGER_SHA256 } from './installed-policy.js';
import { readLiveConfigFile } from './effective-config.js';
import { observeLiveProcess } from './process-identity.js';
import {
  originalLaunchSurfaces,
  LIVE_CONTEXT_TOOL_NAMES,
  LIVE_ORG_TOOL_NAMES,
  ORIGINAL_CONTEXT_TOOL_NAMES,
  installedMcpBudgets,
} from './installed-launch-contract.js';
import type { ProductionLiveConfiguration } from './production-configuration.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import type { OwningRuntimeCapture } from './owning-runtime-capture.js';

const mock = vi.hoisted(() => ({
  permissions: vi.fn(),
  native: vi.fn(),
  bridge: vi.fn(),
  drained: vi.fn(),
}));
vi.mock('./owning-permissions.js', async (original) => ({
  ...(await original<typeof import('./owning-permissions.js')>()),
  owningPermissions: mock.permissions,
}));
vi.mock('./owning-observation.js', () => ({ observeOwningNative: mock.native }));
vi.mock('./original-bridge-lifetime.js', () => ({
  captureOriginalBridge: mock.bridge,
  assertOriginalBridgeDrained: mock.drained,
}));
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture(
  options: {
    stageRequired?: boolean;
    presealStarting?: boolean;
    postsealExtraTool?: boolean;
    missingExtension?: boolean;
    disabledGestalt?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'live-production-installed-'));
  roots.push(root);
  const appRoot = join(root, 'app'),
    runtimeHome = join(root, 'worker'),
    directory = join(root, 'private'),
    home = join(root, 'owner');
  for (const path of [appRoot, runtimeHome, directory, home]) mkdirSync(path, { mode: 0o700 });
  const hash = 'a'.repeat(64),
    configPath = join(home, 'config.toml'),
    workerConfig = join(runtimeHome, 'config.toml');
  writeFileSync(configPath, '[features]\nhooks = false\n', { mode: 0o600 });
  writeFileSync(workerConfig, '[shell_environment_policy]\ninherit = "none"\n', { mode: 0o600 });
  const sourcePath = join(directory, 'production.json');
  writeFileSync(sourcePath, '{}', { mode: 0o600 });
  const installedSource = {
    kind: 'context-mode-bridge-v1' as const,
    path: join(home, 'bin/context-mode-mcp.mjs'),
    sha256: hash,
    gestaltHome: join(root, 'gestalt'),
    interpreter: { path: '/usr/bin/node', sha256: hash },
    package: { root: '/accepted/context-mode/2.16.1', version: '2.16.1', treeDigest: hash },
    runtime: { root: '/accepted/runtime', treeDigest: hash },
  };
  const originalSources = [
    {
      kind: 'installed-launch-source' as const,
      descriptor: installedSource,
      observation: { launcher: { sha256: hash } },
    },
  ];
  const original = originalLaunchSurfaces(
    installedSource,
    options.disabledGestalt
      ? {
          'context-mode@dyne-gestalt-agents': { enabled: false },
          'gestalt@dyne-gestalt-agents': { enabled: false },
        }
      : undefined,
  );
  writeFileSync(
    configPath,
    stringify({
      features: { hooks: false },
      mcp_servers: original.mcpServers,
      plugins: original.plugins,
    }),
    { mode: 0o600 },
  );
  const state = {
    permissionProfile: {
      type: 'managed' as const,
      file_system: {
        type: 'restricted' as const,
        entries: [
          { path: { type: 'special' as const, value: { kind: 'root' } }, access: 'read' as const },
        ],
      },
      network: 'restricted' as const,
    },
    sandboxCwd: appRoot,
    useLegacyLandlock: false as const,
  };
  const app = {
    appRoot,
    workspaceRoot: appRoot,
    plans: [],
    owningPolicy: {
      profileId: 'owning',
      sandboxState: state,
      configFiles: [readLiveConfigFile(configPath)],
      instructionFiles: [],
      originalLaunchSources: [installedSource],
    },
  } as unknown as ProductionLiveConfiguration['apps'][number];
  const configuration = {
    privateDirectory: directory,
    nativeEnvironment: { CODEX_HOME: home },
    installation: {
      manager: { path: '/accepted/manager', sha256: LIVE_MANAGER_SHA256 },
      node: { path: '/usr/bin/node', sha256: hash },
      packages: [
        { name: 'context-mode', root: '/accepted/context-mode/2.16.1', sha256: hash },
        { name: 'gestalt', root: '/accepted/gestalt', sha256: hash },
      ],
      runtime: { root: '/accepted/runtime', sha256: hash },
    },
    components: { manager: 'accepted', mobile: 'fixture', agents: 'accepted' },
    caddy: { controllerDirectory: directory },
  } as unknown as ProductionLiveConfiguration;
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ configFiles: app.owningPolicy!.configFiles }), {
    mode: 0o600,
  });
  const capture = {
    captureId: 'captured',
    sessionId: 'owner',
    generation: 1,
    directory,
    manifestPath,
    runtimeHome,
    keyPath: join(directory, 'key'),
    policyDigest: hash,
    captured: { appRoot, directories: [], instructions: {} },
    baselineState: state,
    projectState: state,
    state,
    originalLaunchSources: originalSources,
  } as OwningRuntimeCapture;
  const session = {
    ...RelaySession.create({
      id: 'owner',
      provider: 'codex',
      workspaceId: 'workspace',
      workspacePath: appRoot,
      profile: 'default',
      model: 'selected',
      effectiveSkillSelection: { skills: [] },
      now: 'time',
    }).snapshot,
    threadId: 'same-thread',
  };
  const catalogServer = (name: string, names: readonly string[], runtimeStatus = 'connected') => ({
    name,
    runtimeStatus,
    tools: Object.fromEntries(names.map((name) => [name, {}])),
    toolsError: null,
    httpOrigin: null,
  });
  const observation = {
    launch: observeLiveProcess(process.pid),
    launchEnvironment: { codexHome: home, home, tmpdir: '/tmp' },
    configuration: {
      config: {
        features: { hooks: false },
        mcp_servers: original.mcpServers,
        plugins: original.plugins,
      },
      layers: [
        {
          name: { type: 'user', file: configPath },
          version: '1',
          config: { features: { hooks: false } },
        },
      ],
    },
    account: {},
    thread: {},
    mcp: { data: [catalogServer('context-mode', ORIGINAL_CONTEXT_TOOL_NAMES)], nextCursor: null },
    threadSelection: { instructionSources: [] },
    threadConfig: {},
    skillsConfig: undefined,
  };
  const selection = {
    modelProvider: 'selected-provider',
    reasoningEffort: 'high',
    activePermissionProfile: { id: 'owning', extends: null },
    approvalPolicy: 'never',
  };
  mock.permissions.mockReturnValue({ state, selection });
  mock.native.mockReturnValue({ sessionFlags: {}, accountDigest: hash });
  mock.bridge.mockReturnValue([{ pid: 1 }]);
  mock.drained.mockResolvedValue(undefined);
  const events: string[] = [];
  vi.spyOn(InstalledLivePolicy.prototype, 'validateInstallation').mockImplementation(() => {});
  vi.spyOn(InstalledLivePolicy.prototype, 'stage').mockImplementation(
    async (_manifest, bootstrap) => {
      const cfg = JSON.parse(readFileSync(bootstrap, 'utf8'));
      const mcpServers = Object.fromEntries(
        ['context-mode', 'gestalt-org-plan'].map((name) => [
          name,
          {
            command: configuration.installation.node.path,
            args: [
              '/accepted/gestalt/live-mcp-proxy.mjs',
              '--bootstrap',
              bootstrap,
              '--server',
              name,
            ],
            cwd: appRoot,
            env: {},
            default_tools_approval_mode: 'approve',
            enabled: true,
            required: options.stageRequired ?? false,
            ...installedMcpBudgets(name, true),
          },
        ]),
      );
      expect(cfg.consumer.capabilities).toEqual(['suspension-v1']);
      const path = join(directory, 'staged.json');
      writeFileSync(path, JSON.stringify({ mcpServers }), { mode: 0o600 });
      events.push('stage');
      return path;
    },
  );
  vi.spyOn(InstalledLivePolicy.prototype, 'assertOriginalSourceBirth').mockImplementation(
    async () => {
      events.push('birth');
    },
  );
  vi.spyOn(InstalledLivePolicy.prototype, 'sealRuntime').mockImplementation(async () => {
    events.push('seal');
    return {
      ...(options.missingExtension ? {} : { extensions: ['original-installed-launch-source-v1'] }),
      originalLaunchSources: originalSources,
    };
  });
  vi.spyOn(InstalledLivePolicy.prototype, 'prepare').mockImplementation(async () => {
    events.push('prepare');
    return { policyDigest: hash, configDigest: hash, admissionDigest: hash };
  });
  let count = 0,
    modelConfig: Readonly<Record<string, unknown>> = {};
  const reconfigure = vi.fn(async (value: Readonly<Record<string, unknown>>) => {
    count++;
    modelConfig = value;
    events.push('reconfigure');
  });
  const observe = vi.fn(async () => ({
    ...observation,
    threadConfig: modelConfig,
    configuration: {
      ...observation.configuration,
      // Native config/read retains original file layers; session flags are
      // returned separately and must not erase original disabled plugin entries.
      config: observation.configuration.config,
    },
    mcp: {
      data: [
        catalogServer(
          'context-mode',
          count === 1
            ? []
            : [...LIVE_CONTEXT_TOOL_NAMES, ...(options.postsealExtraTool ? ['unsafe'] : [])],
          count === 1 ? (options.presealStarting ? 'starting' : 'failed') : 'connected',
        ),
        catalogServer(
          'gestalt-org-plan',
          count === 1 ? [] : LIVE_ORG_TOOL_NAMES,
          count === 1 ? 'failed' : 'connected',
        ),
      ],
      nextCursor: null,
    },
  }));
  return {
    input: {
      configuration,
      source: readLiveConfigFile(sourcePath),
      session,
      observation,
      app,
      directory,
      authenticationDirectory: directory,
      capture,
      reconfigure,
      observe,
    },
    reconfigure,
    events,
  };
}

it.each([false, true])(
  'seals separate executable provenance after retirement and preserves disabled inventory (Gestalt:%s)',
  async (disabledGestalt) => {
    const f = fixture({ disabledGestalt });
    const policy = await prepareProductionPolicy(f.input);
    expect(f.events).toEqual(['stage', 'reconfigure', 'birth', 'seal', 'prepare', 'reconfigure']);
    expect(mock.bridge).toHaveBeenCalledWith(
      f.input.observation.launch,
      f.input.app.owningPolicy!.originalLaunchSources![0],
    );
    expect(mock.drained).toHaveBeenCalledOnce();
    expect(
      policy.sourceInventory.sources.some((source) => source.kind === 'installed-launch-source'),
    ).toBe(true);
    expect(
      policy.sourceInventory.sources
        .filter((source) => source.kind === 'file')
        .every((source) => !String(source.path).endsWith('.mjs')),
    ).toBe(true);
    expect(f.input.observe).toHaveBeenCalledTimes(2);
    expect(policy.modelConfig.plugins).toEqual(f.input.observation.configuration.config.plugins);
    expect(f.input.observation.configuration.config.mcp_servers['context-mode']).toMatchObject({
      enabled: true,
      required: true,
    });
  },
);

it.each([
  { stageRequired: true },
  { presealStarting: true },
  { missingExtension: true },
  { postsealExtraTool: true },
])('refuses an unsupported prepared phase without claiming readiness (%j)', async (options) => {
  const f = fixture(options);
  await expect(prepareProductionPolicy(f.input)).rejects.toThrow(/^LIVE_/);
  if (options.stageRequired) expect(f.reconfigure).not.toHaveBeenCalled();
  if (options.presealStarting) expect(f.events).not.toContain('seal');
  if (options.missingExtension) expect(f.events).not.toContain('prepare');
});
