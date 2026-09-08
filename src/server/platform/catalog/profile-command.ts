/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function profileAppServerCommand(
  skillsConfig?: readonly { path: string; enabled: boolean }[],
): { command: string; args: string[] } {
  const base = { command: 'codex', args: ['app-server', '--stdio'] };
  return skillsConfig === undefined
    ? base
    : {
        ...base,
        args: [
          ...base.args,
          '--config',
          `skills.config = [${skillsConfig.map((entry) => `{ path = ${JSON.stringify(entry.path)}, enabled = ${entry.enabled} }`).join(', ')}]`,
        ],
      };
}
