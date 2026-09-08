/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { profileAppServerCommand } from './profile-command.js';
describe('profileAppServerArgs', () => {
  it('uses Codex directly in the launcher-established environment', () =>
    expect(profileAppServerCommand()).toEqual({
      command: 'codex',
      args: ['app-server', '--stdio'],
    }));

  it('keeps native arguments byte-identical without a skill override', () => {
    expect(profileAppServerCommand()).toEqual(profileAppServerCommand(undefined));
  });

  it('passes skills.config as one non-shell child argument', () =>
    expect(profileAppServerCommand([{ path: '/skills/$quoted/SKILL.md', enabled: false }])).toEqual(
      {
        command: 'codex',
        args: [
          'app-server',
          '--stdio',
          '--config',
          'skills.config = [{ path = "/skills/$quoted/SKILL.md", enabled = false }]',
        ],
      },
    ));
});
