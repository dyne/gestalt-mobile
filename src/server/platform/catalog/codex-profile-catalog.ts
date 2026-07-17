/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import type { ProfileCatalog, ProfileOption } from '../../features/catalog/application/ports.js';

const execute = promisify(execFile);
const statusSchema = z.object({
  profiles: z.array(
    z.object({
      name: z.string(),
      state: z.enum(['ok', 'not_logged_in', 'error']),
      status: z.string(),
      home: z.string().optional(),
    }),
  ),
});

export class CodexProfileCatalog implements ProfileCatalog {
  constructor(
    private readonly command: () => Promise<string> = async () =>
      (await execute('codex-profile', ['status', '--json'])).stdout,
    private readonly defaultHomeExists: () => boolean = () => existsSync(join(homedir(), '.codex')),
  ) {}
  async list(): Promise<ProfileOption[]> {
    const profiles = statusSchema
      .parse(JSON.parse(await this.command()))
      .profiles.map(({ name, state, status }) => ({ name, state, status }));
    return profiles.length || !this.defaultHomeExists()
      ? profiles
      : [{ name: 'default', state: 'ok', status: 'Using ~/.codex' }];
  }
  async require(name: string): Promise<ProfileOption> {
    const profile = (await this.list()).find((item) => item.name === name);
    if (!profile) throw new Error('PROFILE_NOT_FOUND');
    return profile;
  }
}
