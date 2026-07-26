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
  skillsConfig?: readonly { path: string; enabled: boolean }[],
): { command: string; args: string[] } {
  void _profile;
  const base = availability.codexProfileAvailable() && availability.gestaltHomeExists()
    ? { command: 'codex-profile', args: ['cli', 'gestalt', 'app-server', '--stdio'] }
    : { command: 'codex', args: ['app-server', '--stdio'] };
  return skillsConfig === undefined
    ? base
    : { ...base, args: [...base.args, '--config', `skills.config = [${skillsConfig.map((entry) => `{ path = ${JSON.stringify(entry.path)}, enabled = ${entry.enabled} }`).join(', ')}]`] };
}
