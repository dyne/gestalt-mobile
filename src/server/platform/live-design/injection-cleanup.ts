/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

const marker = z.string().min(1).max(8192);
const artifact = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), path: z.string().min(1), marker }).passthrough(),
  z
    .object({
      kind: z.literal('patched'),
      path: z.string().min(1),
      markers: z.array(marker).min(1).max(64),
    })
    .passthrough(),
]);
export type LiveInjectionArtifacts = readonly z.infer<typeof artifact>[];
const journal = (appRoot: string) => join(appRoot, '.impeccable/live/inject-journal.json');
function inside(appRoot: string, value: string): string {
  const path = join(appRoot, value),
    tail = relative(appRoot, path);
  if (
    isAbsolute(value) ||
    !tail ||
    tail === '..' ||
    tail.startsWith(`..${sep}`) ||
    isAbsolute(tail)
  )
    throw new Error('LIVE_INJECTION_CLEANUP_UNVERIFIED');
  return path;
}
function read(path: string, limit: number): string {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit ||
    realpathSync(path) !== path
  )
    throw new Error('LIVE_INJECTION_CLEANUP_UNVERIFIED');
  return readFileSync(path, 'utf8');
}
/** Snapshot the actual helper journal before removal can erase partial-failure
 * evidence. This inventory grants no command/path-writing authority. */
export function captureLiveInjection(appRoot: string): LiveInjectionArtifacts {
  try {
    const parsed = z
      .object({
        version: z.literal(1),
        appRoot: z.literal(appRoot),
        artifacts: z.array(artifact).min(1).max(128),
      })
      .passthrough()
      .parse(JSON.parse(read(journal(appRoot), 1024 * 1024)));
    for (const item of parsed.artifacts) read(inside(appRoot, item.path), 8 * 1024 * 1024);
    return structuredClone(parsed.artifacts);
  } catch {
    throw new Error('LIVE_INJECTION_CLEANUP_UNVERIFIED');
  }
}
/** CLI success and journal deletion do not prove filesystem cleanup. Inspect
 * every original artifact even when the helper reported a successful removal. */
export function verifyLiveInjectionRemoved(
  appRoot: string,
  artifacts: LiveInjectionArtifacts,
): void {
  try {
    if (existsSync(journal(appRoot)) || !artifacts.length) throw new Error();
    for (const item of artifacts) {
      const path = inside(appRoot, item.path);
      if (!existsSync(path)) {
        // Patched source files must survive cleanup.
        if (item.kind === 'patched') throw new Error();
        continue;
      }
      const content = read(path, 8 * 1024 * 1024);
      if (item.kind === 'created' || item.markers.some((value) => content.includes(value)))
        throw new Error();
    }
  } catch {
    throw new Error('LIVE_INJECTION_CLEANUP_UNVERIFIED');
  }
}
