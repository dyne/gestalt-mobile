/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'smol-toml';
import { mergeLiveConfig, readLiveConfigFile, type LiveConfigFile } from './effective-config.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const empty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (object(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).length === 0);

/** Validate every private original source BEFORE creating signing authority or
 * starting a thread. TOML parsing handles quoted/dotted keys and multiline values;
 * no regular-expression scan or permissive parser fallback can hide executables. */
export function validateOriginalLaunchSources(input: {
  owningHome: string;
  files: readonly LiveConfigFile[];
  threadConfig: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  try {
    const paths = new Map(input.files.map((file) => [file.path, file.sha256]));
    if (paths.size !== input.files.length || !paths.has(join(input.owningHome, 'config.toml')))
      throw new Error();
    const parsed = new Map<string, Record<string, unknown>>();
    for (const file of input.files) {
      if (readLiveConfigFile(file.path).sha256 !== file.sha256) throw new Error();
      const config = parse(readFileSync(file.path, 'utf8'), { unsafeKeyBehaviour: 'throw' });
      if (readLiveConfigFile(file.path).sha256 !== file.sha256) throw new Error();
      parsed.set(file.path, config);
    }
    const roles = new Set<string>();
    const inspect = (config: Readonly<Record<string, unknown>>, depth = 0) => {
      if (depth > 4 || config.project_doc_max_bytes === 0) throw new Error();
      for (const key of [
        'mcp_servers',
        'plugins',
        'hooks',
        'remote_mcp',
        'executables',
        'notify',
        'browser_use',
        'computer_use',
        'desktop',
        'apps',
      ])
        if (!empty(config[key])) throw new Error();
      if (object(config.features) && config.features.hooks === true) throw new Error();
      if (object(config.profiles))
        for (const value of Object.values(config.profiles)) {
          if (!object(value)) throw new Error();
          inspect(value, depth + 1);
        }
      if (object(config.agents))
        for (const value of Object.values(config.agents)) {
          if (!object(value) || !Object.hasOwn(value, 'config_file')) continue;
          if (
            typeof value.config_file !== 'string' ||
            !isAbsolute(value.config_file) ||
            !paths.has(value.config_file)
          )
            throw new Error();
          roles.add(value.config_file);
        }
    };
    // Validate every original layer independently, including currently shadowed
    // profiles and roles; adding an override never conceals a launch surface.
    for (const config of parsed.values()) inspect(config);
    if (
      Object.keys(input.threadConfig).some((key) =>
        /^(mcp_servers|plugins|hooks|agents|profiles|remote_mcp|executables|notify|apps)\.|^features\.hooks(?:\.|$)/.test(
          key,
        ),
      )
    )
      throw new Error();
    inspect(input.threadConfig);
    for (const role of roles) {
      const config = parsed.get(role)!;
      const allowed = [
        'name',
        'description',
        'developer_instructions',
        'model',
        'model_reasoning_effort',
      ];
      if (
        Object.entries(config).some(
          ([key, value]) => !allowed.includes(key) || typeof value !== 'string',
        )
      )
        throw new Error();
    }
    let configuration: Record<string, unknown> = {};
    for (const [path, config] of parsed)
      if (!roles.has(path)) configuration = mergeLiveConfig(configuration, config);
    const merged = mergeLiveConfig(configuration, input.threadConfig);
    if (!object(merged.features) || merged.features.hooks !== false) throw new Error();
    return merged;
  } catch {
    // Parser exceptions contain source lines and config values. Never relay them.
    throw new Error('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
  }
}
