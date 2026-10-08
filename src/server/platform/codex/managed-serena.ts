/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const serenaTools = [
  'get_symbols_overview',
  'find_symbol',
  'initial_instructions',
  'replace_symbol_body',
];
export type SerenaInstallation =
  | { status: 'absent' }
  | { status: 'unavailable' }
  | { status: 'installed'; manager: string; version: string };

/** Read shared executable metadata only; never prepare a project with operator authority. */
export class ManagedSerena {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async check(): Promise<SerenaInstallation> {
    const home =
      this.environment.GESTALT_HOME ?? join(this.environment.HOME ?? homedir(), '.gestalt');
    try {
      const path = join(home, 'serena', 'active.json');
      if ((await stat(path)).size > 262_144) return { status: 'unavailable' };
      const install = JSON.parse(await readFile(path, 'utf8'));
      if (
        install.schemaVersion !== 1 ||
        install.contractVersion !== 1 ||
        !/^\d+\.\d+\.\d+$/.test(install.version) ||
        !Array.isArray(install.tools) ||
        !serenaTools.every((name) =>
          install.tools.some(
            (tool: { name?: string; inputSchema?: { type?: string } }) =>
              tool.name === name && tool.inputSchema?.type === 'object',
          ),
        )
      )
        return { status: 'unavailable' };
      for (const executable of [install.executable, install.python, install.uv]) {
        if (typeof executable !== 'string' || !isAbsolute(executable))
          return { status: 'unavailable' };
        await access(executable, constants.X_OK);
      }
      if (
        typeof install.pythonInstallDir !== 'string' ||
        !isAbsolute(install.pythonInstallDir) ||
        !(await stat(install.pythonInstallDir)).isDirectory()
      )
        return { status: 'unavailable' };
      const candidates = this.environment.GESTALT_MANAGER_BIN
        ? [this.environment.GESTALT_MANAGER_BIN]
        : (this.environment.PATH ?? '')
            .split(':')
            .filter(Boolean)
            .map((path) => join(path, 'gestalt'));
      for (const manager of candidates) {
        if (!isAbsolute(manager)) continue;
        try {
          await access(manager, constants.X_OK);
          return { status: 'installed', manager, version: install.version };
        } catch {
          /* Try the next established manager path. */
        }
      }
      return { status: 'unavailable' };
    } catch (error) {
      return {
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable',
      };
    }
  }
}
