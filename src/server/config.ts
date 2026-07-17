/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';

export type RelayConfig = {
  host: string;
  port: number;
  root: string;
  dataDir?: string;
};

export class CliUsageError extends Error {
  readonly exitCode = 2;
}

const optionNames = new Set(['--cwd', '--host', '--port', '--data-dir']);

export function parseConfig(args: string[], cwd = process.cwd()): RelayConfig {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith('--')) throw new CliUsageError(`Unexpected argument: ${option}`);
    if (!optionNames.has(option)) throw new CliUsageError(`Unknown option: ${option}`);
    if (values.has(option)) throw new CliUsageError(`Duplicate option: ${option}`);

    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliUsageError(`Missing value for ${option}`);
    values.set(option, value);
    index += 1;
  }

  const portValue = values.get('--port') ?? '3000';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CliUsageError(`Invalid --port: ${portValue}`);

  return {
    host: values.get('--host') ?? '127.0.0.1',
    port,
    root: resolve(cwd, values.get('--cwd') ?? '.'),
    dataDir: values.get('--data-dir'),
  };
}
