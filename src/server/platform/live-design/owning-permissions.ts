/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isAbsolute, normalize, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CodexSessionRuntime } from '../codex/session-runtime.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';
import { mergeLiveConfig } from './effective-config.js';
import { LIVE_CODEX_SHA256 } from './native-contract.js';
import { liveSourceDigest } from './owning-source-inventory.js';

type Observation = Awaited<ReturnType<CodexSessionRuntime['inspectLiveAdmission']>>;
const record = z.record(z.string(), z.unknown());
const profileSchema = z
  .object({
    description: z.string().optional(),
    extends: z.string().optional(),
    filesystem: record.optional(),
    network: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    workspace_roots: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();
const inside = (root: string, path: string) => {
  const tail = relative(root, path);
  return !tail || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
};
export function normalizedLivePermissions(
  state: ManagedProjectSandboxState,
): ManagedProjectSandboxState {
  return {
    ...state,
    permissionProfile: {
      ...state.permissionProfile,
      file_system: {
        ...state.permissionProfile.file_system,
        entries: [
          ...new Map(
            state.permissionProfile.file_system.entries.map((entry) => [
              liveSourceDigest(entry),
              entry,
            ]),
          ).entries(),
        ]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, entry]) => entry),
      },
    },
  };
}
/** Uncertain or broader writable roots are global, never omitted as scratch. */
export function livePolicyAppConfined(state: ManagedProjectSandboxState, appRoot: string): boolean {
  return state.permissionProfile.file_system.entries.every(
    (entry) =>
      entry.access !== 'write' || (entry.path.type === 'path' && inside(appRoot, entry.path.path)),
  );
}

/** Pinned native 0.161 exact/scoped paths and bounded deny-glob subset. Parent-first merge and built-in
 * read/workspace inheritance follow config/permissions.rs + permissions_toml.rs.
 * Unsupported relative/proxy policies and unbounded deny globs are refused, never approximated.
 */
export function owningPermissions(input: {
  session: RelaySessionSnapshot;
  observation: Observation;
  appRoot: string;
  protectedPaths: readonly string[];
}): { state: ManagedProjectSandboxState; selection: Readonly<Record<string, unknown>> } {
  try {
    const { session, observation } = input;
    const selection = observation.threadSelection;
    const appRoot = realpathSync(input.appRoot);
    const active = record.parse(selection?.activePermissionProfile);
    if (
      session.provider !== 'codex' ||
      !session.threadId ||
      !session.model ||
      observation.launch.executableDigest !== LIVE_CODEX_SHA256 ||
      selection?.threadId !== session.threadId ||
      selection.model !== session.model ||
      selection.cwd !== appRoot ||
      session.workspacePath !== appRoot ||
      (session.modelSettings?.reasoningEffort &&
        selection.reasoningEffort !== session.modelSettings.reasoningEffort) ||
      typeof selection.modelProvider !== 'string' ||
      !selection.modelProvider ||
      /kimi|moonshot/i.test(selection.modelProvider) ||
      /kimi|moonshot/i.test(session.model) ||
      typeof active.id !== 'string' ||
      active.id.startsWith(':')
    )
      throw new Error();
    const configuration = record.parse(record.parse(observation.configuration).config);
    const merged = mergeLiveConfig(configuration, observation.threadConfig);
    const profiles = record.parse(merged.permissions);
    const workspace =
      merged.sandbox_workspace_write === undefined
        ? {}
        : record.parse(merged.sandbox_workspace_write);
    const visited = new Set<string>();
    const resolve = (name: string): Record<string, unknown> => {
      if (name === ':read-only') return { filesystem: { ':root': 'read' } };
      if (name === ':workspace')
        return {
          filesystem: {
            ':root': 'read',
            ':workspace_roots': 'write',
            ...(workspace.exclude_slash_tmp === true ? {} : { ':slash_tmp': 'write' }),
            ...(workspace.exclude_tmpdir_env_var === true ? {} : { ':tmpdir': 'write' }),
          },
        };
      if (visited.has(name) || visited.size >= 16) throw new Error();
      visited.add(name);
      const profile = profileSchema.parse(profiles[name]);
      const parent = profile.extends ? resolve(profile.extends) : {};
      return mergeLiveConfig(parent, profile);
    };
    const declared = profileSchema.parse(profiles[active.id]);
    if (!isDeepStrictEqual(active.extends ?? null, declared.extends ?? null)) throw new Error();
    const profile = profileSchema.parse(resolve(active.id));
    const networkEnabled = profile.network?.enabled === true;
    const roots = z.array(z.string()).max(32).parse(selection.runtimeWorkspaceRoots);
    if (
      !roots.length ||
      roots.some((root) => realpathSync(root) !== root || !inside(appRoot, root))
    )
      throw new Error();
    const entries: ManagedProjectSandboxState['permissionProfile']['file_system']['entries'][number][] =
      [];
    const filesystem = profile.filesystem ?? {};
    const depth = filesystem.glob_scan_max_depth;
    if (
      depth !== undefined &&
      (!Number.isSafeInteger(depth) || Number(depth) < 1 || Number(depth) > 256)
    )
      throw new Error();
    const emit = (path: string, access: unknown) => {
      if (!['read', 'write', 'deny'].includes(String(access))) throw new Error();
      const mode = access as 'read' | 'write' | 'deny';
      if ([':root', ':minimal', ':slash_tmp'].includes(path)) {
        if (path === ':root' && mode === 'write') throw new Error();
        entries.push({
          path: {
            type: 'special',
            value: {
              kind: { ':root': 'root', ':minimal': 'minimal', ':slash_tmp': 'slash_tmp' }[path]!,
            },
          },
          access: mode,
        });
        return;
      }
      if (!isAbsolute(path) || normalize(path) !== path) throw new Error();
      if (/[*?\[\]{}]/.test(path)) {
        if (mode !== 'deny' || (path.includes('**') && depth === undefined)) throw new Error();
        entries.push({ path: { type: 'glob_pattern', pattern: path }, access: mode });
        return;
      }
      try {
        if (realpathSync(path) !== path) throw new Error();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mode === 'write') throw error;
      }
      entries.push({ path: { type: 'path', path }, access: mode });
    };
    for (const [path, access] of Object.entries(filesystem).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (path === 'glob_scan_max_depth') continue;
      let bases: string[];
      if (path === ':workspace_roots') bases = roots;
      else if (path === ':tmpdir') {
        const tmpdir = observation.launchEnvironment?.tmpdir;
        if (!tmpdir || !isAbsolute(tmpdir) || realpathSync(tmpdir) !== tmpdir) throw new Error();
        bases = [tmpdir];
      } else if (path === ':root') bases = ['/'];
      else if (path === ':slash_tmp') bases = ['/tmp'];
      else bases = [path];
      if (access && typeof access === 'object' && !Array.isArray(access)) {
        if (path === ':minimal') throw new Error();
        for (const [subpath, mode] of Object.entries(access)) {
          if (!subpath || isAbsolute(subpath) || subpath.split('/').includes('..'))
            throw new Error();
          for (const base of bases) emit(normalize(base + '/' + subpath), mode);
        }
      } else if (path === ':workspace_roots' || path === ':tmpdir') {
        for (const base of bases) emit(base, access);
      } else emit(path, access);
    }
    if (
      !entries.length ||
      !entries.some(
        (entry) =>
          entry.access === 'write' &&
          entry.path.type === 'path' &&
          inside(entry.path.path, appRoot),
      )
    )
      throw new Error();
    // Baseline exclusion must ALREADY be effective before creating authority keys.
    // A more-specific allow cannot override a parent denial in this admission proof.
    for (const path of input.protectedPaths) {
      if (
        !isAbsolute(path) ||
        !entries.some(
          (entry) =>
            entry.access === 'deny' && entry.path.type === 'path' && inside(entry.path.path, path),
        ) ||
        entries.some(
          (entry) =>
            entry.access !== 'deny' && entry.path.type === 'path' && inside(path, entry.path.path),
        )
      )
        throw new Error();
    }
    const legacy = record.parse(selection.sandbox);
    if (
      (legacy.networkAccess === true) !== networkEnabled ||
      !['workspaceWrite', 'workspace-write', 'readOnly', 'read-only'].includes(String(legacy.type))
    )
      throw new Error();
    return {
      state: {
        permissionProfile: {
          type: 'managed',
          file_system: {
            type: 'restricted',
            entries,
            ...(depth !== undefined ? { glob_scan_max_depth: Number(depth) } : {}),
          },
          network: networkEnabled ? 'enabled' : 'restricted',
        },
        sandboxCwd: pathToFileURL(appRoot).href,
        useLegacyLandlock: false,
      },
      selection: structuredClone(selection),
    };
  } catch {
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  }
}
