/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
        disabledReason: z.string().nullable(),
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
}): readonly LiveConfigFile[] {
  try {
    const observed = configuration.parse(input.configuration);
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
    const merged = mergeLiveConfig(observed.config, input.threadConfig);
    if (
      !isDeepStrictEqual(merged.mcp_servers ?? {}, input.approved.mcpServers) ||
      !isDeepStrictEqual(merged.plugins ?? {}, input.approved.plugins)
    )
      throw new Error();
    const paths = new Set<string>();
    const roles = new Set<string>();
    const inspect = (config: Record<string, unknown>) => {
      for (const key of [
        'hooks',
        'remote_mcp',
        'executables',
        'browser_use',
        'computer_use',
        'desktop',
      ]) {
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
      if (
        features &&
        typeof features === 'object' &&
        'hooks' in features &&
        features.hooks === true
      )
        throw new Error();
      const agents = config.agents;
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
      const type = layer.name.type;
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
    return Object.freeze(
      [...paths].sort().map((path) => {
        const pin = readLiveConfigFile(path);
        if (roles.has(path)) {
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
  } catch {
    throw new Error('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  }
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
