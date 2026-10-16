/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  readLiveConfigFile,
  resolveLiveConfigFiles,
  type LiveConfigFile,
} from './effective-config.js';
import type { LiveProcessIdentity } from './process-identity.js';
import type { OwningNativeObservation } from './owning-observation.js';

const systemSources = [
  '/etc/codex/config.toml',
  '/etc/codex/managed_config.toml',
  '/etc/codex/requirements.toml',
] as const;
const record = z.record(z.string(), z.unknown());
const response = z.object({
  config: record,
  layers: z
    .array(z.object({ name: record, config: record, version: z.string().min(1) }))
    .min(1)
    .max(64),
});
const instructionPaths = z.array(z.string()).max(128);
type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  ctime: number;
  mtime: number;
}>;
type InstructionPin = Readonly<{ sha256: string; identity: FileIdentity }>;
export type CapturedLiveSources = Readonly<{
  appRoot: string;
  directories: readonly string[];
  instructions: Readonly<Record<string, InstructionPin | null>>;
}>;

export function liveSourceDigest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : item,
      ),
    )
    .digest('hex');
}
function identity(path: string): FileIdentity {
  const info = lstatSync(path);
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
    ctime: info.ctimeMs,
    mtime: info.mtimeMs,
  };
}
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
function instruction(path: string): InstructionPin {
  const before = identity(path),
    file = readLiveConfigFile(path),
    after = identity(path);
  if (
    !isDeepStrictEqual(before, after) ||
    before.mode & 0o022 ||
    ![0, process.getuid?.()].includes(before.uid)
  )
    throw new Error('LIVE_CONFIG_CHANGED');
  return Object.freeze({ sha256: file.sha256, identity: Object.freeze(before) });
}

/** Trusted controller observation BEFORE original birth; this alone grants no
 * authority. Manager independently signs absence/identity and rechecks it at seal/use. */
export function captureLiveSources(
  appRoot: string,
  owningHome: string,
  declared: readonly string[] = [],
): CapturedLiveSources {
  for (const path of [appRoot, owningHome])
    if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('LIVE_CONFIG_CHANGED');
  for (const path of declared)
    if (
      !isAbsolute(path) ||
      normalize(path) !== path ||
      realpathSync(dirname(path)) !== dirname(path) ||
      (!absent(path) && realpathSync(path) !== path)
    )
      throw new Error('LIVE_CONFIG_CHANGED');
  if (declared.length > 64) throw new Error('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  const directories: string[] = [];
  for (let root = appRoot; ; root = dirname(root)) {
    const path = join(root, '.codex');
    if (!absent(path))
      throw Object.assign(new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE'), {
        code: 'LIVE_PROJECT_METADATA_PRESENT',
      });
    directories.push(path);
    if (root === '/') break;
  }
  const candidates = [
    ...new Set([
      ...directories.flatMap((path) =>
        ['AGENTS.md', 'AGENTS.override.md'].map((name) => join(dirname(path), name)),
      ),
      join(owningHome, 'AGENTS.md'),
      ...declared,
    ]),
  ];
  for (const path of systemSources)
    if (!absent(path)) throw new Error('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  return Object.freeze({
    appRoot,
    directories: Object.freeze(directories),
    instructions: Object.freeze(
      Object.fromEntries(candidates.map((path) => [path, absent(path) ? null : instruction(path)])),
    ),
  });
}

/** Build the complete actual Native source inventory. Directory and instruction
 * candidates never masquerade as config files; no empty-directory trust is granted. */
export function resolveLiveSourceInventory(input: {
  captured: CapturedLiveSources;
  configuration: unknown;
  threadConfig: Readonly<Record<string, unknown>>;
  selection: Readonly<Record<string, unknown>>;
  observation?: OwningNativeObservation;
  runtime: LiveProcessIdentity;
  policyDigest: string;
  workerConfig: LiveConfigFile;
  approved: Parameters<typeof resolveLiveConfigFiles>[0]['approved'];
}) {
  try {
    const observed = response.parse(input.configuration);
    const files = resolveLiveConfigFiles({
      configuration: input.configuration,
      threadConfig: input.threadConfig,
      approved: input.approved,
      appRoot: input.captured.appRoot,
      capturedProjectSources: input.captured.directories,
    });
    const pins = new Map(files.map((file) => [file.path, file]));
    const sources: Record<string, unknown>[] = [];
    const emitted = new Set<string>();
    const addFile = (path: string, role: string) => {
      const file = pins.get(path);
      if (!file) throw new Error();
      if (emitted.has(path)) throw new Error();
      emitted.add(path);
      sources.push({ kind: 'file', role, ...file });
    };
    for (const layer of observed.layers) {
      const name = layer.name;
      if (name.type === 'project' || name.type === 'sessionFlags') continue;
      const path = z.string().parse(name.file);
      if (absent(path)) {
        if (
          !systemSources.includes(path as (typeof systemSources)[number]) ||
          Object.keys(layer.config).length
        )
          throw new Error();
        continue;
      }
      // Present system configuration is unsupported even when disabled/empty.
      if (systemSources.includes(path as (typeof systemSources)[number])) throw new Error();
      const role = {
        user: 'user',
        packagedDefaults: 'packaged-defaults',
        legacyManagedConfigTomlFromFile: 'managed',
      }[String(name.type)];
      if (!role) throw new Error();
      addFile(path, role);
    }
    for (const file of files) if (!emitted.has(file.path)) addFile(file.path, 'agent-role');
    if (
      emitted.has(input.workerConfig.path) ||
      !isDeepStrictEqual(readLiveConfigFile(input.workerConfig.path), input.workerConfig)
    )
      throw new Error();
    sources.push({ kind: 'file', role: 'sandbox-worker', ...input.workerConfig });
    for (const path of input.captured.directories) {
      if (absent(path)) {
        sources.push({ kind: 'absent', role: 'project', path });
        continue;
      }
      const info = lstatSync(path),
        before = identity(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        realpathSync(path) !== path ||
        readdirSync(path).length ||
        !isDeepStrictEqual(before, identity(path))
      )
        throw new Error();
      sources.push({
        kind: 'directory',
        role: 'project',
        path,
        identity: { ...before, birthtime: info.birthtimeMs },
      });
    }
    for (const path of systemSources) {
      if (!absent(path)) throw new Error();
      sources.push({ kind: 'absent', role: 'system', path });
    }
    const loaded = instructionPaths.parse(input.selection.instructionSources);
    if (
      new Set(loaded).size !== loaded.length ||
      loaded.some(
        (path) =>
          !Object.hasOwn(input.captured.instructions, path) || !input.captured.instructions[path],
      )
    )
      throw new Error();
    for (const [path, prior] of Object.entries(input.captured.instructions)) {
      if (!prior) {
        if (!absent(path)) throw new Error();
        continue;
      }
      const current = instruction(path);
      if (!isDeepStrictEqual(current, prior)) throw new Error();
      sources.push({
        kind: loaded.includes(path) ? 'instruction' : 'instruction-candidate',
        path,
        ...current,
      });
    }
    if (
      sources.length > 128 ||
      new Set(sources.map((source) => source.path)).size !== sources.length
    )
      throw new Error();
    const { pid, birth, uid, namespaces } = input.runtime;
    return {
      schemaVersion: 2 as const,
      runtime: {
        pid,
        birth,
        uid,
        namespaces: { mnt: namespaces.mnt, user: namespaces.user, pid: namespaces.pid },
      },
      policyDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(input.policyDigest),
      effectiveConfigDigest: liveSourceDigest(observed.config),
      sessionFlagsDigest: liveSourceDigest(input.observation?.sessionFlags ?? input.selection),
      sources,
      ...(input.observation ? { observation: structuredClone(input.observation) } : {}),
    };
  } catch {
    throw new Error('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
  }
}
