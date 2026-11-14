/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Synthetic package data, never a second copy of the production guide.
export const syntheticBootstrap = 'SYNTHETIC_SELECTED_PACKAGE_BOOTSTRAP\n';
export const syntheticBlock = `<!-- gestalt:startup:v1 -->\n${syntheticBootstrap}<!-- /gestalt:startup -->`;
export const startupDescriptor = {
  schemaVersion: 1,
  owner: 'gestalt-agents',
  blockId: 'gestalt:startup',
  blockVersion: 1,
  source: 'startup/bootstrap.md',
  composer: 'scripts/startup-contract.mjs',
  maxWords: 350,
};

export async function installStartupFixture(root: string, version = '0.0.1') {
  for (const path of ['.codex-plugin', 'startup', 'skills/coding', 'skills/serena'])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: 'gestalt',
      version,
      description: 'Synthetic Mobile startup fixture',
      skills: './skills/',
    }),
  );
  await writeFile(join(root, 'gestalt-startup-contract.json'), JSON.stringify(startupDescriptor));
  await writeFile(join(root, 'startup/bootstrap.md'), syntheticBootstrap);
  for (const name of ['coding', 'serena'])
    await writeFile(
      join(root, `skills/${name}/SKILL.md`),
      `---\nname: ${name}\ndescription: Synthetic ${name} fixture\n---\nSYNTHETIC_${name.toUpperCase()}_GUIDANCE\n`,
    );
  return ['coding', 'serena'].map((name) => ({
    name: `gestalt:${name}`,
    path: join(root, `skills/${name}/SKILL.md`),
    enabled: true,
  }));
}
