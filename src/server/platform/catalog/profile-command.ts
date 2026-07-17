import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type GestaltProfileAvailability = {
  codexProfileAvailable(): boolean;
  gestaltHomeExists(): boolean;
};

const localAvailability: GestaltProfileAvailability = {
  codexProfileAvailable: () => !spawnSync('codex-profile', ['--version'], { stdio: 'ignore' }).error,
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
