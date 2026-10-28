/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

const suiteSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    repository: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string().max(4096)).max(64),
    timeoutMs: z.number().int().min(100).max(3_600_000),
    maxOutputBytes: z.number().int().min(1024).max(16_777_216),
  })
  .strict();
const configSchema = z
  .object({ version: z.literal(1), suites: z.array(suiteSchema).max(32) })
  .strict();
export type HostTestSuite = z.infer<typeof suiteSchema>;

export function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

/** Reload agent-editable workspace suites on demand. Absence permits later creation. */
export async function loadWorkspaceHostTestConfig(workspaceRoot: string): Promise<HostTestSuite[]> {
  const root = await realpath(workspaceRoot);
  const path = join(root, '.gestalt', 'host-tests.json');
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const canonical = await realpath(path);
  if (!within(root, canonical) || info.isSymbolicLink() || !info.isFile() || info.size > 65536) {
    throw new Error('Host test configuration must be a bounded regular file within the workspace');
  }
  const config = configSchema.parse(JSON.parse(await readFile(canonical, 'utf8')));
  return validateSuites(config.suites, root);
}

async function validateSuites(suites: HostTestSuite[], root: string): Promise<HostTestSuite[]> {
  const names = new Set<string>();
  for (const suite of suites) {
    if (names.has(suite.id) || !isAbsolute(suite.repository) || !isAbsolute(suite.command)) {
      throw new Error(
        'Host test suites require unique names and absolute repository/command paths',
      );
    }
    names.add(suite.id);
    suite.repository = await realpath(suite.repository);
    if (!within(root, suite.repository))
      throw new Error('Host test repository is outside the workspace');
    const executable = await lstat(suite.command);
    if (!executable.isFile() && !executable.isSymbolicLink())
      throw new Error('Invalid host test executable');
  }
  return suites;
}
