/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const authModules = [
  new URL('./domain/authorization.ts', import.meta.url),
  new URL('./domain/device-nickname.ts', import.meta.url),
  new URL('./domain/errors.ts', import.meta.url),
  new URL('./domain/identifiers.ts', import.meta.url),
  new URL('./application/ports.ts', import.meta.url),
];
const forbiddenImports =
  /from\s+['"](?:fastify|@fastify\/|node:(?:fs|child_process)|better-sqlite3|sqlite|svelte|@simplewebauthn\/)/;

describe('auth domain and application boundary', () => {
  it('does not depend on framework, storage, filesystem, or WebAuthn integration modules', async () => {
    for (const module of authModules) {
      const source = await readFile(module, 'utf8');
      expect(source).not.toMatch(forbiddenImports);
    }
  });
});
