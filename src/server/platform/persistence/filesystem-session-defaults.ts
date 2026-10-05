/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  sessionDefaultsSchema,
  type SessionDefaults,
  type SessionDefaultsStore,
} from '../../../shared/contracts/session-defaults.js';

export class FilesystemSessionDefaults implements SessionDefaultsStore {
  readonly directory: string;
  readonly path: string;
  constructor(homeDirectory: string) {
    this.directory = join(homeDirectory, '.gestalt');
    this.path = join(this.directory, 'session-defaults.json');
  }
  async read(): Promise<SessionDefaults | null> {
    try {
      return sessionDefaultsSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async save(defaults: SessionDefaults): Promise<void> {
    const validated = sessionDefaultsSchema.parse(defaults);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
