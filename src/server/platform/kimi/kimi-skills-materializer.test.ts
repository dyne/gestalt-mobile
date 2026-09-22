/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeKimiSkillsDir } from './kimi-skills-materializer.js';
import type { SkillSelection } from '../../features/skills/model/skill-profile.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-materializer-'));
  roots.push(root);
  return root;
}
const selection = (entries: SkillSelection): SkillSelection => entries;

describe('materializeKimiSkillsDir', () => {
  it('links only enabled entries and keeps either skill shape', async () => {
    const root = await sandbox();
    const skillsDir = join(root, 'skills');
    const dirSkill = join(root, 'team', 'deploy');
    await mkdir(dirSkill, { recursive: true });
    await writeFile(join(dirSkill, 'SKILL.md'), '---\nname: deploy\n---\n');
    const flatSkill = join(root, 'team', 'review.md');
    await mkdir(join(root, 'team'), { recursive: true });
    await writeFile(flatSkill, '---\nname: review\n---\n');

    const result = materializeKimiSkillsDir(
      skillsDir,
      selection([
        { name: 'deploy', path: dirSkill, enabled: true },
        { name: 'review', path: flatSkill, enabled: true },
        { name: 'secret', path: join(root, 'team', 'secret'), enabled: false },
      ]),
    );
    expect(result.linked).toEqual([dirSkill, flatSkill]);
    expect(result.skipped).toEqual([]);
    expect(await readlink(join(skillsDir, 'deploy'))).toBe(dirSkill);
    expect(await readlink(join(skillsDir, 'review.md'))).toBe(flatSkill);
  });

  it('skips later entries whose basename collides with an earlier link', async () => {
    const root = await sandbox();
    const skillsDir = join(root, 'skills');
    const first = join(root, 'a', 'deploy');
    const second = join(root, 'b', 'deploy');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const result = materializeKimiSkillsDir(
      skillsDir,
      selection([
        { name: 'deploy-a', path: first, enabled: true },
        { name: 'deploy-b', path: second, enabled: true },
      ]),
    );
    expect(result.linked).toEqual([first]);
    expect(result.skipped).toEqual([second]);
    expect(await readlink(join(skillsDir, 'deploy'))).toBe(first);
  });

  it('ignores relative paths and rebuilds from an empty directory on refresh', async () => {
    const root = await sandbox();
    const skillsDir = join(root, 'skills');
    const first = materializeKimiSkillsDir(
      skillsDir,
      selection([
        { name: 'odd', path: 'relative/path', enabled: true },
        { name: 'gone', path: join(root, 'gone'), enabled: true },
      ]),
    );
    expect(first.linked).toEqual([join(root, 'gone')]);
    const second = materializeKimiSkillsDir(skillsDir, selection([]));
    expect(second.linked).toEqual([]);
  });
});
