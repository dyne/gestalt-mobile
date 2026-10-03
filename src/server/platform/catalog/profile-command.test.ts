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

  it('keeps skill catalogs out of process arguments', () => {
    expect(profileAppServerCommand().args).toEqual(['app-server', '--stdio']);
  });
});
