/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';

import { gestaltEnvironment } from './gestalt-environment.mjs';

describe('repository Gestalt environment', () => {
  it('uses managed defaults and makes user-installed CLIs discoverable', () => {
    const environment = gestaltEnvironment({ PATH: '/usr/bin' }, '/home/tester');

    expect(environment.CODEX_HOME).toBe('/home/tester/.codex-gestalt');
    expect(environment.GESTALT_HOME).toBe('/home/tester/.gestalt');
    expect(environment.PATH?.split(delimiter)).toEqual([
      '/home/tester/.local/bin',
      '/home/tester/bin',
      '/home/tester/.kimi-code/bin',
      '/usr/bin',
    ]);
  });

  it('preserves explicit homes and removes duplicate path entries', () => {
    const environment = gestaltEnvironment(
      {
        CODEX_HOME: '/custom/codex',
        GESTALT_HOME: '/custom/gestalt',
        PATH: `/home/tester/.local/bin${delimiter}/usr/bin`,
      },
      '/home/tester',
    );

    expect(environment.CODEX_HOME).toBe('/custom/codex');
    expect(environment.GESTALT_HOME).toBe('/custom/gestalt');
    expect(environment.PATH?.split(delimiter)).toEqual([
      '/home/tester/.local/bin',
      '/home/tester/bin',
      '/home/tester/.kimi-code/bin',
      '/usr/bin',
    ]);
  });
});
