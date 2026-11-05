/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AvailableSkill } from '../../features/skills/model/skill-profile.js';

export type StartupGuidance = {
  status: 'ready' | 'unavailable';
  reason?:
    | 'excluded'
    | 'ambiguous-selected-package'
    | 'missing-contract'
    | 'native-config-unavailable'
    | 'unsupported-contract'
    | 'invalid-contract';
  packageVersion?: string;
  blockVersion?: number;
  sha256?: string;
};

/** Native discovery selects the installed package; never scan caches or consult a checkout. */
export async function prepareStartupGuidance(input: {
  instructions: string;
  native: Record<string, unknown>;
  skills: readonly AvailableSkill[];
  skillsConfig: readonly { path: string; enabled: boolean }[];
}): Promise<{ instructions: string; startup: StartupGuidance }> {
  const unchanged = (reason: StartupGuidance['reason'], packageVersion?: string) => ({
    instructions: input.instructions,
    startup: {
      status: 'unavailable' as const,
      reason,
      ...(packageVersion ? { packageVersion } : {}),
    },
  });
  const rules = input.native.skills as
    | {
        include_instructions?: boolean;
        config?: { name?: string; path?: string; enabled?: boolean }[];
      }
    | undefined;
  if (rules?.include_instructions === false) return unchanged('excluded');
  const selected = input.skills.filter(
    (skill) =>
      skill.name.startsWith('gestalt:') &&
      skill.enabled !== false &&
      [...(rules?.config ?? []), ...input.skillsConfig]
        .filter((rule) => ('name' in rule && rule.name === skill.name) || rule.path === skill.path)
        .at(-1)?.enabled !== false,
  );
  if (!selected.length) return unchanged('excluded');
  let packageVersion: string | undefined;
  try {
    const roots = new Set(
      await Promise.all(
        selected.map(async (skill) => resolve(await realpath(skill.path), '../../..')),
      ),
    );
    if (roots.size !== 1) return unchanged('ambiguous-selected-package');
    const root = [...roots][0]!;
    const manifest = JSON.parse(await readFile(resolve(root, '.codex-plugin/plugin.json'), 'utf8'));
    if (
      manifest.name !== 'gestalt' ||
      manifest.skills !== './skills/' ||
      typeof manifest.version !== 'string' ||
      manifest.version.length > 64 ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version)
    )
      return unchanged('invalid-contract');
    packageVersion = manifest.version;
    let descriptor;
    try {
      descriptor = JSON.parse(
        await readFile(resolve(root, 'gestalt-startup-contract.json'), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return unchanged('missing-contract', packageVersion);
      throw error;
    }
    if (descriptor.schemaVersion !== 1 || descriptor.blockVersion !== 1)
      return unchanged('unsupported-contract', packageVersion);
    if (
      descriptor.owner !== 'gestalt-agents' ||
      descriptor.blockId !== 'gestalt:startup' ||
      descriptor.source !== 'startup/bootstrap.md' ||
      descriptor.composer !== 'scripts/startup-contract.mjs' ||
      descriptor.maxWords !== 350
    )
      throw new Error('Invalid descriptor');
    const text = await readFile(resolve(root, descriptor.source), 'utf8');
    if (!text.trim() || text.trim().split(/\s+/u).length > 350 || text.includes('<!--'))
      throw new Error('Invalid bootstrap');
    // Version-1 composition mirrors the Agents contract. Outside bytes are immutable.
    const pattern = /<!-- gestalt:startup:v(\d+) -->[\s\S]*?<!-- \/gestalt:startup -->/gu;
    const matches = [...input.instructions.matchAll(pattern)];
    if (
      (input.instructions.match(/<!-- gestalt:startup/gu) ?? []).length !== matches.length ||
      (input.instructions.match(/<!-- \/gestalt:startup/gu) ?? []).length !== matches.length ||
      matches.some((match) => match[1] !== '1')
    )
      throw new Error('Invalid owned block');
    const block = `<!-- gestalt:startup:v1 -->\n${text}<!-- /gestalt:startup -->`;
    let first = true;
    const instructions = matches.length
      ? input.instructions.replace(pattern, () => {
          if (!first) return '';
          first = false;
          return block;
        })
      : input.instructions + (input.instructions ? '\n\n' : '') + block;
    return {
      instructions,
      startup: {
        status: 'ready',
        packageVersion,
        blockVersion: 1,
        sha256: createHash('sha256').update(block).digest('hex'),
      },
    };
  } catch {
    // Never echo source text, paths, parser errors or user customization.
    return unchanged('invalid-contract', packageVersion);
  }
}
