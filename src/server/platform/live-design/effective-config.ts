/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const object = z.record(z.string(), z.unknown());
const configuration = z.object({
  config: object,
  layers: z
    .array(
      z.object({
        name: object,
        version: z.string().min(1),
        config: object,
        // Native 0.161 omits disabledReason for enabled layers (serde None).
        disabledReason: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(64),
});
export type LiveConfigFile = Readonly<{ path: string; sha256: string }>;
export type LiveApprovedLaunchSurfaces = Readonly<{
  mcpServers: Readonly<Record<string, unknown>>;
  plugins: Readonly<Record<string, unknown>>;
}>;

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function mergeLiveConfig(
  base: Record<string, unknown>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const prior = Object.hasOwn(result, key) ? result[key] : undefined;
    const merged =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prior &&
      typeof prior === 'object' &&
      !Array.isArray(prior)
        ? mergeLiveConfig(prior as Record<string, unknown>, value as Record<string, unknown>)
        : structuredClone(value);
    Object.defineProperty(result, key, {
      value: merged,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/** Inventory the files the native owning runtime actually resolved, including agent profiles. */
export function resolveLiveConfigFiles(input: {
  configuration: unknown;
  threadConfig: Readonly<Record<string, unknown>>;
  approved: LiveApprovedLaunchSurfaces;
  /** Registered root for bounded diagnostics only; never grants project trust. */
  appRoot?: string;
  /** Inventory only. Manager must independently seal these captured directory
   * sources before they can confer any admission authority. */
  capturedProjectSources?: readonly string[];
}): readonly LiveConfigFile[] {
  let stage = 'response-shape';
  let launchInventory: unknown;
  try {
    const observed = configuration.parse(input.configuration);
    stage = 'thread-launch-overrides';
    // Native config overrides interpret dotted keys as table paths. Do not mistake
    // one for an inert JSON property and omit its launch effect from this inventory.
    if (
      Object.keys(input.threadConfig).some((key) =>
        /^(mcp_servers|plugins|hooks|agents|profiles|remote_mcp|executables)\.|^features\.hooks(?:\.|$)/.test(
          key,
        ),
      )
    )
      throw new Error();
    const nativeConfig = structuredClone(observed.config);
    // Native 0.161 serializes its local environment and an unset tool timeout.
    // These defaults are readback metadata, never authority for source or thread
    // overrides. Preserve every other field for the exact launch comparison.
    const servers = nativeConfig.mcp_servers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const descriptor of Object.values(servers)) {
        if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) continue;
        if ('environment_id' in descriptor && descriptor.environment_id === 'local')
          delete descriptor.environment_id;
        if ('tool_timeout_sec' in descriptor && descriptor.tool_timeout_sec === null)
          delete descriptor.tool_timeout_sec;
      }
    }
    const merged = mergeLiveConfig(nativeConfig, input.threadConfig);
    launchInventory = Object.fromEntries(
      [
        ['mcp_servers', input.approved.mcpServers],
        ['plugins', input.approved.plugins],
      ].map(([field, approved]) => {
        const key = field as string;
        const summary = (value: unknown) => ({
          type:
            value === undefined
              ? 'absent'
              : value === null
                ? 'null'
                : Array.isArray(value)
                  ? 'array'
                  : typeof value,
          count:
            value && typeof value === 'object' && !Array.isArray(value)
              ? Math.min(Object.keys(value).length, 65)
              : null,
        });
        return [
          key,
          {
            native: summary(observed.config[key]),
            thread: summary(input.threadConfig[key]),
            merged: summary(merged[key]),
            matchesApproved: isDeepStrictEqual(merged[key] ?? {}, approved),
          },
        ];
      }),
    );
    for (const [key, approved] of [
      ['mcp_servers', input.approved.mcpServers],
      ['plugins', input.approved.plugins],
    ] as const) {
      stage = `approved-launch-surface-${key}`;
      if (!isDeepStrictEqual(merged[key] ?? {}, approved)) throw new Error();
    }
    const paths = new Set<string>();
    const roles = new Set<string>();
    const inspect = (config: Record<string, unknown>) => {
      stage = 'instruction-discovery';
      if (config.project_doc_max_bytes === 0) throw new Error();
      for (const key of [
        'hooks',
        'remote_mcp',
        'executables',
        'notify',
        'apps',
        'browser_use',
        'computer_use',
        'desktop',
      ]) {
        stage = `launch-surface-${key}`;
        const value = config[key];
        if (
          value !== undefined &&
          value !== null &&
          !isDeepStrictEqual(value, {}) &&
          !isDeepStrictEqual(value, [])
        )
          throw new Error();
      }
      const features = config.features;
      stage = 'hooks-feature';
      if (
        features &&
        typeof features === 'object' &&
        'hooks' in features &&
        features.hooks === true
      )
        throw new Error();
      const agents = config.agents;
      stage = 'agent-config-reference';
      if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
        for (const value of Object.values(agents)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          if ('config_file' in value) {
            if (typeof value.config_file !== 'string') throw new Error();
            paths.add(value.config_file);
            roles.add(value.config_file);
          }
        }
      }
    };
    inspect(merged);
    for (const layer of observed.layers) {
      // Disabled layers can become enabled after trust/config changes; inventory them too.
      inspect(layer.config);
      stage = 'layer-provenance';
      const type = layer.name.type;
      if (type === 'project' && input.capturedProjectSources) {
        const path = layer.name.dotCodexFolder;
        const ancestry: string[] = [];
        if (!input.appRoot) throw new Error();
        for (let root = input.appRoot; ; root = dirname(root)) {
          ancestry.push(join(root, '.codex'));
          if (root === '/') break;
        }
        if (
          typeof path !== 'string' ||
          !ancestry.includes(path) ||
          !input.capturedProjectSources.includes(path) ||
          Object.keys(layer.config).length
        )
          throw new Error();
        continue;
      }
      if (
        type === 'project' ||
        type === 'mdm' ||
        type === 'enterpriseManaged' ||
        type === 'legacyManagedConfigTomlFromMdm'
      )
        throw new Error();
      if (type === 'sessionFlags') continue;
      if (
        !['user', 'system', 'packagedDefaults', 'legacyManagedConfigTomlFromFile'].includes(
          String(type),
        )
      )
        throw new Error();
      if (typeof layer.name.file !== 'string') throw new Error();
      stage = 'layer-source-path';
      // Native can describe a nonexistent system/user layer. It must be empty and disabled.
      try {
        if (realpathSync(layer.name.file) !== layer.name.file) throw new Error();
        paths.add(layer.name.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Object.keys(layer.config).length)
          throw error;
      }
    }
    // A synthesized empty layers array is never evidence of the owning configuration.
    if (!paths.size) throw new Error();
    stage = 'source-file-inventory';
    return Object.freeze(
      [...paths].sort().map((path) => {
        const pin = readLiveConfigFile(path);
        if (roles.has(path)) {
          stage = 'role-file-inventory';
          const bytes = readFileSync(path);
          if (hash(bytes) !== pin.sha256) throw new Error();
          // v1 admits the installed/session-generated informational/model role
          // subset. Unknown TOML tables and settings can introduce independent
          // MCP, hooks, environments or executables; do not inventory and ignore them.
          const allowed = new Set([
            'name',
            'description',
            'developer_instructions',
            'model',
            'model_reasoning_effort',
          ]);
          const seen = new Set<string>();
          for (const line of bytes.toString('utf8').split('\n')) {
            if (!line.trim() || line.trim().startsWith('#')) continue;
            const match = /^\s*([a-z_]+)\s*=\s*(".*")\s*$/.exec(line);
            if (
              !match ||
              !allowed.has(match[1]!) ||
              seen.has(match[1]!) ||
              typeof JSON.parse(match[2]!) !== 'string'
            )
              throw new Error();
            seen.add(match[1]!);
          }
          if (readLiveConfigFile(path).sha256 !== pin.sha256) throw new Error();
        }
        return pin;
      }),
    );
  } catch (error) {
    throw Object.assign(new Error('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE'), {
      liveConfigDiagnostics: summarizeLiveConfigShape(
        input.configuration,
        stage,
        error instanceof z.ZodError ? error.issues : [],
        input.appRoot,
      ),
      liveLaunchInventory: launchInventory,
    });
  }
}

/** Fixed field types/presence only: never paths, config values, or unknown keys. */
function summarizeLiveConfigShape(
  value: unknown,
  stage: string,
  issues: z.ZodError['issues'],
  appRoot?: string,
) {
  const kind = (entry: unknown): string =>
    entry === undefined
      ? 'absent'
      : entry === null
        ? 'null'
        : Array.isArray(entry)
          ? 'array'
          : typeof entry;
  const record = (entry: unknown): Record<string, unknown> =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
  const response = record(value);
  const types = [
    'packagedDefaults',
    'system',
    'user',
    'sessionFlags',
    'project',
    'mdm',
    'enterpriseManaged',
    'legacyManagedConfigTomlFromFile',
    'legacyManagedConfigTomlFromMdm',
  ];
  const layers = Array.isArray(response.layers) ? response.layers : [];
  return {
    stage,
    shapeIssues: issues.slice(0, 8).map((issue) => ({
      field: issue.path
        .map((part) =>
          typeof part === 'number' && part >= 0 && part < 64
            ? part
            : ['config', 'layers', 'name', 'version', 'disabledReason'].includes(String(part))
              ? part
              : 'unrecognized',
        )
        .join('.'),
      code: issue.code,
    })),
    configType: kind(response.config),
    layersType: kind(response.layers),
    layerCount: Math.min(layers.length, 65),
    layers: layers.slice(0, 64).map((entry) => {
      const layer = record(entry),
        name = record(layer.name);
      return {
        source:
          typeof name.type === 'string' && types.includes(name.type) ? name.type : 'unrecognized',
        nameType: kind(layer.name),
        fileType: kind(name.file),
        dotCodexFolderType: kind(name.dotCodexFolder),
        projectFolderIsRegisteredAppMetadata:
          appRoot && typeof name.dotCodexFolder === 'string'
            ? name.dotCodexFolder === join(appRoot, '.codex')
            : null,
        versionType: kind(layer.version),
        configType: kind(layer.config),
        disabledReasonType: kind(layer.disabledReason),
      };
    }),
  };
}

/** O_NOFOLLOW plus descriptor identity prevents a replaced final path from being silently trusted. */
export function readLiveConfigFile(path: string): LiveConfigFile {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('LIVE_CONFIG_CHANGED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 262144 || before.nlink !== 1)
      throw new Error('LIVE_CONFIG_CHANGED');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const final = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(final);
      if (
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size ||
        !bytes.equals(readFileSync(final))
      )
        throw new Error('LIVE_CONFIG_CHANGED');
    } finally {
      closeSync(final);
    }
    return Object.freeze({ path, sha256: hash(bytes) });
  } finally {
    closeSync(fd);
  }
}
