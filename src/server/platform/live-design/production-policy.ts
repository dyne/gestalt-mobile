/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import type { OwningRuntimeCapture } from './owning-runtime-capture.js';
import { resolveLiveSourceInventory } from './owning-source-inventory.js';
import type { ProductionLiveConfiguration } from './production-configuration.js';
import { normalizedLivePermissions as normalize, owningPermissions } from './owning-permissions.js';

type Observation = Awaited<ReturnType<CodexSessionRuntime['inspectLiveAdmission']>>;
export type PreparedProductionPolicy = {
  directory: string;
  capture: OwningRuntimeCapture;
  sourceInventory: ReturnType<typeof resolveLiveSourceInventory>;
  expectedServers: Record<string, unknown>;
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

/** Canonical declared Org source surface; the restricted Live proxy keeps env: {}. */
export function productionOrgMcpSource(root: string) {
  return {
    name: 'gestalt-org-plan',
    command: 'node',
    args: ['./org-plan-mcp.mjs'],
    cwd: root,
    env_vars: [
      'GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY',
      'GESTALT_MOBILE_ORG_PLAN_STATUS_FILE',
      'GESTALT_MOBILE_ORG_PLAN_CAPABILITIES',
    ],
    default_tools_approval_mode: 'approve',
  };
}

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
  capture: OwningRuntimeCapture;
  reconfigure(modelConfig: Readonly<Record<string, unknown>>): Promise<void>;
  observe(): Promise<Observation>;
}): Promise<PreparedProductionPolicy> {
  const { configuration: cfg, session, observation, app, directory } = input;
  const { capture } = input;
  if (
    capture.sessionId !== session.id ||
    capture.directory !== directory ||
    capture.captured.appRoot !== app.appRoot
  )
    throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
  const original = observation.configuration as { config?: Record<string, unknown> };
  const mcp = observation.mcp as { data?: unknown[]; nextCursor?: unknown };
  if (!Array.isArray(mcp?.data) || mcp.data.length || mcp.nextCursor)
    throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
  const merged = mergeLiveConfig(original.config ?? {}, observation.threadConfig);
  // Original host delegates remain unsupported. The installed two Live packages
  // below are explicitly selected by the trusted host configuration, not claimed
  // to be the observed original inventory.
  const files = resolveLiveConfigFiles({
    configuration: observation.configuration,
    appRoot: app.appRoot,
    capturedProjectSources: capture.captured.directories,
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
    '/proc',
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
  if (
    !isDeepStrictEqual(normalize(baselineState), normalize(capture.baselineState)) ||
    !isDeepStrictEqual(
      [...files].sort((a, b) => a.path.localeCompare(b.path)),
      [...(app.owningPolicy?.configFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    )
  )
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  const policy = new InstalledLivePolicy(cfg.installation);
  policy.validateInstallation();
  const runtimeHome = capture.runtimeHome;
  const workerConfig = join(runtimeHome, 'config.toml');
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
  const keyPath = capture.keyPath;
  const probePath = join(directory, 'private-denial-probe');
  writeFileSync(probePath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const manifestPath = capture.manifestPath,
    bootstrapPath = join(directory, 'bootstrap.json');
  const gestalt = cfg.installation.packages.find((entry) => entry.name === 'gestalt')!;
  const state = capture.state;
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
        network: { enabled: state.permissionProfile.network === 'enabled' },
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
  json(bootstrapPath, {
    schemaVersion: 1,
    consumer: {
      schemaVersion: 1,
      component: cfg.components.mobile,
      capabilities: ['suspension-v1'],
    },
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
          : productionOrgMcpSource(root),
      ),
      hooks: [],
      remoteMcp: [],
      executables: [],
    },
    plans: app.plans,
  });
  const stagedPath = await policy.stage(manifestPath, bootstrapPath, [
    ...files,
    readLiveConfigFile(workerConfig),
  ]);
  const prepared = JSON.parse(readFileSync(stagedPath, 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  if (!isDeepStrictEqual(prepared.mcpServers, expectedServers))
    throw new Error('LIVE_CONFIG_CHANGED');
  await input.reconfigure(modelConfig);
  const actual = await input.observe();
  const effective = owningPermissions({
    session,
    observation: actual,
    appRoot: app.appRoot,
    protectedPaths,
  });
  if (!isDeepStrictEqual(normalize(effective.state), normalize(state)))
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  if (
    !isDeepStrictEqual(
      actual.threadSelection?.instructionSources,
      observation.threadSelection?.instructionSources,
    )
  )
    throw new Error('LIVE_INSTRUCTION_DISCOVERY_CHANGED');
  const sourceInventory = resolveLiveSourceInventory({
    captured: capture.captured,
    configuration: actual.configuration,
    threadConfig: actual.threadConfig,
    selection: {
      ...actual.threadSelection,
      threadConfig: actual.threadConfig,
      skillsConfig: actual.skillsConfig ?? null,
    },
    runtime: actual.launch,
    policyDigest: capture.policyDigest,
    workerConfig: readLiveConfigFile(workerConfig),
    approved: { mcpServers: expectedServers, plugins: {} },
  });
  if (!isDeepStrictEqual(actual.threadConfig, modelConfig)) throw new Error('LIVE_CONFIG_CHANGED');
  const sourcesPath = join(directory, 'owning-sources.json');
  json(sourcesPath, sourceInventory);
  await policy.sealRuntime(manifestPath, capture.captureId, actual.launch.pid, sourcesPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.runtimeProvenance = {
    captureId: capture.captureId,
    effectiveConfigDigest: sourceInventory.effectiveConfigDigest,
    sessionFlagsDigest: sourceInventory.sessionFlagsDigest,
  };
  manifest.configFiles = configs;
  const temporary = join(directory, 'sealed-manifest.tmp');
  json(temporary, manifest);
  renameSync(temporary, manifestPath);
  const digests = await policy.prepare(manifestPath, bootstrapPath, configs);
  // Initial MCP startup preceded signed receipts and could not grant work.
  // Cold-resume the same idle thread to connect its now-admitted descriptors.
  await input.reconfigure(modelConfig);

  return {
    directory,
    capture,
    sourceInventory,
    expectedServers,
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

/** Re-resolve actual owning RPC state at every Live model admission. Stored
 * digests and signed receipts alone cannot assert that current session flags match. */
export function assertProductionSourceObservation(
  policy: PreparedProductionPolicy,
  observation: Observation,
): void {
  const current = resolveLiveSourceInventory({
    captured: policy.capture.captured,
    configuration: observation.configuration,
    threadConfig: observation.threadConfig,
    selection: {
      ...observation.threadSelection,
      threadConfig: observation.threadConfig,
      skillsConfig: observation.skillsConfig ?? null,
    },
    runtime: observation.launch,
    policyDigest: policy.capture.policyDigest,
    workerConfig: readLiveConfigFile(join(policy.capture.runtimeHome, 'config.toml')),
    approved: { mcpServers: policy.expectedServers, plugins: {} },
  });
  if (!isDeepStrictEqual(current, policy.sourceInventory)) throw new Error('LIVE_CONFIG_CHANGED');
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
