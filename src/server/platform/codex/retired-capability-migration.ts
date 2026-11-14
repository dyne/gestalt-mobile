/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** In-memory retirement only: never change native configuration or user data. */
export function retireLegacyCapabilityInstructions(instructions: string): string {
  const stack: string[] = [];
  let start = 0;
  let nested = false;
  let copied = 0;
  let retained = '';
  for (const marker of instructions.matchAll(/<(\/?)gestalt_xerj_(capability|unavailable)>/gu)) {
    const [, closing, kind] = marker;
    if (!closing) {
      if (stack.length === 0) {
        start = marker.index;
        nested = false;
      } else nested = true;
      stack.push(kind);
    } else if (stack.length) {
      // Mismatched or nested markers leave their entire enclosing region intact.
      if (stack.at(-1) !== kind) {
        nested = true;
        continue;
      }
      stack.pop();
      if (stack.length === 0 && !nested) {
        retained += instructions.slice(copied, start);
        copied = marker.index + marker[0].length;
      }
    }
  }
  // Unclosed regions are copied verbatim, including any complete inner markers.
  return retained + instructions.slice(copied);
}

function managedArguments(value: unknown): boolean {
  if (!Array.isArray(value) || value[0] !== 'xerj' || value[1] !== 'mcp') return false;
  if (value.length === 2) return true;
  // Earlier Mobile thread overrides used this exact loopback endpoint form.
  if (value.length !== 4 || value[2] !== '--url' || typeof value[3] !== 'string') return false;
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(value[3])) return false;
  try {
    const port = Number(new URL(value[3]).port || 80);
    return port >= 1 && port <= 65535;
  } catch {
    return false;
  }
}

/**
 * A mixed-version installation must migrate before a native thread can launch
 * a retired managed service. Names alone never establish ownership. Unresolved
 * executables, custom arguments and user transports remain native-owned.
 */
export async function assertNoLegacyManagedConnection(
  servers: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  const candidates = Object.values(servers).filter(
    (server): server is Record<string, unknown> =>
      !!server &&
      typeof server === 'object' &&
      !Array.isArray(server) &&
      server.enabled !== false &&
      !server.url &&
      typeof server.command === 'string' &&
      isAbsolute(server.command) &&
      managedArguments(server.args),
  );
  if (!candidates.length) return;
  const paths = environment.GESTALT_MANAGER_BIN
    ? [environment.GESTALT_MANAGER_BIN]
    : (environment.PATH ?? '')
        .split(':')
        .filter(Boolean)
        .map((path) => join(path, 'gestalt'));
  let manager: string | undefined;
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    try {
      await access(path, constants.X_OK);
      manager = await realpath(path);
      break;
    } catch {
      /* Missing manager identity grants no migration authority. */
    }
  }
  if (!manager) return;
  for (const server of candidates) {
    const executable = await realpath(String(server.command)).catch(() => undefined);
    if (executable === manager)
      throw new Error(
        'Retired Gestalt-managed Xerj connection requires migration. Run gestalt update, then reopen the session. Configuration and user data are unchanged.',
      );
  }
}
