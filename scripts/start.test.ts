/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { localStartArgs } from './start.mjs';

describe('local start arguments', () => {
  it('uses a non-conflicting port and isolated state by default', () => {
    expect(localStartArgs([])).toEqual([
      'node',
      'dist/server/server/main.js',
      '--port',
      '3001',
      '--data-dir',
      '.gestalt/start-state',
    ]);
  });

  it('preserves explicit runtime locations', () => {
    expect(localStartArgs(['--port', '4100', '--data-dir', '/tmp/mobile'])).toEqual([
      'node',
      'dist/server/server/main.js',
      '--port',
      '4100',
      '--data-dir',
      '/tmp/mobile',
    ]);
  });
});
