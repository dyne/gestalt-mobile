/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { managedXerjVersion } from './managed-xerj.js';

// Content-affecting rc.87 settings. Reused in the command and fingerprint so
// changing an operational setting cannot accidentally require a rebuild.
export const xerjContentArguments = [
  '--no-graph',
  '--no-semantic',
  '--max-file-gb',
  '1',
  '--sample',
  '500',
  '--pdf-timeout-secs',
  '120',
] as const;

export function xerjIndexConfig(root: string, prefix: string, endpoint: string) {
  const settings = {
    root,
    prefix,
    endpoint,
    nativeVersion: managedXerjVersion,
    contentArguments: xerjContentArguments,
    followSymlinks: false,
    label: null,
  };
  return {
    schemaVersion: 1,
    fingerprint: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
    settings,
  };
}

type IndexConfig = ReturnType<typeof xerjIndexConfig>;
const filename = '.gestalt-index-config.json';

/** Unknown legacy indexes still undergo native validation; never bless them early. */
export async function checkXerjIndexConfig(
  directory: string,
  expected: IndexConfig,
): Promise<'missing' | 'compatible' | 'incompatible'> {
  try {
    const saved = JSON.parse(await readFile(join(directory, filename), 'utf8')) as IndexConfig;
    return saved.schemaVersion === expected.schemaVersion &&
      saved.fingerprint === expected.fingerprint &&
      createHash('sha256').update(JSON.stringify(saved.settings)).digest('hex') ===
        saved.fingerprint
      ? 'compatible'
      : 'incompatible';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'incompatible';
  }
}

/** Record only after a successful native generation, atomically and without credentials. */
export async function saveXerjIndexConfig(directory: string, config: IndexConfig): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${filename}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, filename));
  } finally {
    await rm(temporary, { force: true });
  }
}
