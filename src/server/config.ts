/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';
import { isIP } from 'node:net';

export type RelayConfig = {
  host: string;
  port: number;
  passkeyAuthEnabled: boolean;
  /** Stable, configuration-derived WebAuthn contract for every ceremony. */
  relyingParty: RelyingPartyConfig;
  root: string;
  dataDir?: string;
  /** A validated global selection to use for every child session. */
  skillsProfile?: string;
};

export type RelyingPartyConfig = Readonly<{
  /** Stable browser origin used for every WebAuthn ceremony. */
  publicOrigin: string;
  /** Derived from publicOrigin; never from request headers. */
  rpId: string;
  rpName: 'Gestalt Mobile';
}>;

export class CliUsageError extends Error {
  readonly exitCode = 2;
}

const optionNames = new Set([
  '--cwd',
  '--host',
  '--port',
  '--data-dir',
  '--public-origin',
  '--skills',
]);
const flagNames = new Set(['--disable-passkey-auth']);

export function parseConfig(args: string[], cwd = process.cwd()): RelayConfig {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith('--')) throw new CliUsageError(`Unexpected argument: ${option}`);
    if (flagNames.has(option)) {
      if (flags.has(option)) throw new CliUsageError(`Duplicate option: ${option}`);
      flags.add(option);
      continue;
    }
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

  const host = values.get('--host') ?? '127.0.0.1';
  const passkeyAuthEnabled = !flags.has('--disable-passkey-auth');
  const publicOrigin = values.has('--public-origin')
    ? normalizePublicOrigin(values.get('--public-origin')!)
    : defaultPublicOrigin(host, port, passkeyAuthEnabled);

  return {
    host,
    port,
    passkeyAuthEnabled,
    relyingParty: createRelyingPartyConfig(publicOrigin),
    root: resolve(cwd, values.get('--cwd') ?? '.'),
    dataDir: values.get('--data-dir'),
    skillsProfile: values.get('--skills'),
  };
}

export function normalizePublicOrigin(value: string): string {
  if (!/^[a-z][a-z\d+.-]*:\/\/[^/?#\s\\\\]+\/?$/i.test(value))
    throw new CliUsageError(
      '--public-origin must be a bare origin without a path, query, or fragment',
    );

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError(`Invalid --public-origin: ${value}`);
  }

  if (url.username || url.password)
    throw new CliUsageError('--public-origin must not include credentials');
  if (url.pathname !== '/' || url.search || url.hash)
    throw new CliUsageError(
      '--public-origin must be a bare origin without a path, query, or fragment',
    );

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname))
    throw new CliUsageError('--public-origin must use a hostname, not an IP address');
  if (url.protocol === 'http:' && url.hostname === 'localhost') return url.origin;
  if (url.protocol !== 'https:')
    throw new CliUsageError('--public-origin must use HTTPS, except for http://localhost');
  return url.origin;
}

export function createRelyingPartyConfig(publicOrigin: string): RelyingPartyConfig {
  const normalizedOrigin = normalizePublicOrigin(publicOrigin);
  return {
    publicOrigin: normalizedOrigin,
    rpId: new URL(normalizedOrigin).hostname,
    rpName: 'Gestalt Mobile',
  };
}

function defaultPublicOrigin(host: string, port: number, passkeyAuthEnabled: boolean): string {
  if (passkeyAuthEnabled && !isLoopbackHost(host))
    throw new CliUsageError('--public-origin is required when --host is not a loopback address');
  return `http://localhost:${port}`;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
