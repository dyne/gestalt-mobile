/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { profileAppServerCommand } from './profile-command.js';
describe('profileAppServerArgs', () => {
  it('uses the Gestalt profile when its launcher and home are available', () =>
    expect(
      profileAppServerCommand('default', {
        codexProfileAvailable: () => true,
        gestaltHomeExists: () => true,
      }),
    ).toEqual({
      command: 'codex-profile',
      args: ['cli', 'gestalt', 'app-server', '--stdio'],
    }));

  it('falls back to direct Codex when the Gestalt profile home is absent', () =>
    expect(
      profileAppServerCommand('default', {
        codexProfileAvailable: () => true,
        gestaltHomeExists: () => false,
      }),
    ).toEqual({
      command: 'codex',
      args: ['app-server', '--stdio'],
    }));

  it('falls back to direct Codex when codex-profile is unavailable', () =>
    expect(
      profileAppServerCommand('work', {
        codexProfileAvailable: () => false,
        gestaltHomeExists: () => true,
      }),
    ).toEqual({
      command: 'codex',
      args: ['app-server', '--stdio'],
    }));
});
