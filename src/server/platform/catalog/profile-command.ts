/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type GestaltProfileAvailability = {
  codexProfileAvailable(): boolean;
  gestaltHomeExists(): boolean;
};

const localAvailability: GestaltProfileAvailability = {
  codexProfileAvailable: () =>
    !spawnSync('codex-profile', ['--version'], { stdio: 'ignore' }).error,
  gestaltHomeExists: () => existsSync(join(homedir(), '.codex-gestalt')),
};

export function profileAppServerCommand(
  _profile: string,
  availability: GestaltProfileAvailability = localAvailability,
): { command: string; args: string[] } {
  void _profile;
  return availability.codexProfileAvailable() && availability.gestaltHomeExists()
    ? { command: 'codex-profile', args: ['cli', 'gestalt', 'app-server', '--stdio'] }
    : { command: 'codex', args: ['app-server', '--stdio'] };
}
