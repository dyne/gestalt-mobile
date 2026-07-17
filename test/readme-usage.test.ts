/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { usage } from '../src/server/cli.js';

const readme = await readFile('README.md', 'utf8');

describe('npm usage documentation', () => {
  it.each([
    'npx gestalt-mobile --cwd .',
    'npx --yes gestalt-mobile@latest --cwd ~/devel --port 3000',
    'npm install --global gestalt-mobile',
    'gestalt-mobile --cwd .',
    'gestalt-mobile --version',
    'npm install --global gestalt-mobile@latest',
  ])('documents %s', (command) => {
    expect(readme).toContain(command);
  });

  it('documents every option exposed by --help', () => {
    for (const option of usage.matchAll(/^\s+(--[a-z-]+)/gm)) expect(readme).toContain(option[1]);
  });

  it.each([
    'Node.js 24',
    'authenticated',
    '`127.0.0.1`',
    '`--host 0.0.0.0`',
    '`--data-dir <path>`',
    'SIGINT or SIGTERM',
    '`codex-profile cli gestalt app-server --stdio`',
    '`codex app-server --stdio`',
    'SPDX-License-Identifier: AGPL-3.0-or-later',
  ])('documents the support boundary: %s', (requirement) => {
    expect(readme).toContain(requirement);
  });
});
