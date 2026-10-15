/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';

const inside = (root: string, path: string) => {
  const tail = relative(root, path);
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
};

function policyAccess(state: ManagedProjectSandboxState, path: string) {
  const entries = state.permissionProfile.file_system.entries;
  // Accepted Manager v1 cannot represent an explicit glob expansion bound;
  // do not discard it or approximate path matching while adding carveouts.
  if (
    state.permissionProfile.file_system.glob_scan_max_depth !== undefined ||
    entries.some((entry) => entry.path.type === 'glob_pattern')
  )
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  const candidates = entries
    .flatMap((entry) => {
      const root =
        entry.path.type === 'path'
          ? entry.path.path
          : entry.path.type === 'special' && entry.path.value.kind === 'root'
            ? '/'
            : entry.path.type === 'special' && entry.path.value.kind === 'slash_tmp'
              ? '/tmp'
              : null;
      return root && inside(root, path) ? [{ root, mode: entry.access }] : [];
    })
    .sort((a, b) => b.root.length - a.root.length);
  if (
    !candidates.length ||
    candidates
      .filter((entry) => entry.root === candidates[0]!.root)
      .some((entry) => entry.mode !== candidates[0]!.mode)
  )
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  return candidates[0]!.mode;
}

/** Reestablish functional model-output roots after owned process startup.
 * These remain the same authorized paths, not config/provenance placeholders.
 * Existing content is preserved; missing control parents and aliases fail closed.
 */
export function prepareHelperOutputRoots(appRoot: string, state: ManagedProjectSandboxState): void {
  const control = join(appRoot, '.impeccable/live');
  const parent = lstatSync(control);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    realpathSync(appRoot) !== appRoot ||
    realpathSync(control) !== control ||
    policyAccess(state, control) !== 'write'
  )
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  const paths = ['previews', 'artifacts', 'annotations'].map((name) => join(control, name));
  for (const path of paths)
    if (policyAccess(state, path) !== 'write') throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  for (const path of paths) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path)
      throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
  }
}

/** Existing control parents cover records created later. Only actual output
 * directories are initialized; no server, journal, session or receipt is forged.
 * Pinned native bwrap reopens narrower writable children after parent masks.
 */
export function prepareHelperControlLayout(
  appRoot: string,
  state: ManagedProjectSandboxState,
): ManagedProjectSandboxState {
  const entries = state.permissionProfile.file_system.entries;
  const access = (path: string) => policyAccess(state, path);
  const control = join(appRoot, '.impeccable/live');
  const legacy = join(appRoot, '.impeccable-live');
  const legacyServer = join(appRoot, '.impeccable-live.json');
  if (existsSync(legacyServer) || existsSync(join(control, 'server.json')))
    throw new Error('LIVE_EXTERNAL_SERVER_UNVERIFIED');
  if (
    !lstatSync(control).isDirectory() ||
    realpathSync(control) !== control ||
    access(control) !== 'write' ||
    access(legacy) !== 'write'
  )
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  // An alias outside the masked control parent must not expose writable records.
  let count = 0;
  const inspect = (path: string) => {
    if (++count > 10000) throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
      throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
    if (info.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
  };
  inspect(control);
  if (existsSync(legacy)) inspect(legacy);
  const outputs = ['previews', 'artifacts', 'annotations'].map((name) => join(control, name));
  if (
    entries.some((entry) => {
      const path = entry.path;
      return (
        path.type === 'path' &&
        entry.access !== 'deny' &&
        path.path !== control &&
        path.path !== legacy &&
        (inside(legacy, path.path) ||
          (inside(control, path.path) && !outputs.some((output) => inside(output, path.path))))
      );
    })
  )
    throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
  for (const path of [legacy, ...outputs]) {
    if (access(path) !== 'write') throw new Error('LIVE_OWNING_POLICY_UNVERIFIED');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
      throw new Error('LIVE_UNAPPROVED_LAUNCH_SURFACE');
  }
  return {
    ...state,
    permissionProfile: {
      ...state.permissionProfile,
      file_system: {
        ...state.permissionProfile.file_system,
        entries: [
          ...entries.filter(
            (entry) =>
              entry.path.type !== 'path' ||
              ![control, legacy, ...outputs].includes(entry.path.path),
          ),
          { path: { type: 'path', path: control }, access: 'deny' },
          { path: { type: 'path', path: legacy }, access: 'deny' },
          ...outputs.map((path) => ({
            path: { type: 'path' as const, path },
            access: 'write' as const,
          })),
        ],
      },
    },
  };
}
