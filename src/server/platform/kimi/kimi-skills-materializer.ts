/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import type { SkillSelection } from '../../features/skills/model/skill-profile.js';

export type MaterializedSkills = {
  skillsDir: string;
  /** Basenames linked into the materialized directory. */
  linked: string[];
  /** Entries skipped because a skill with the same basename was already linked. */
  skipped: string[];
};

/**
 * Materializes a kimi skills directory from a gestalt skill selection: one
 * symlink per enabled entry, named by the entry's basename. kimi discovers
 * both directory skills (a folder holding `SKILL.md`) and flat `.md` skills
 * in an `extra_skill_dirs` entry, so linking the canonical path as-is
 * preserves either shape.
 *
 * Note: `extra_skill_dirs` only *adds* directories on top of kimi's automatic
 * user/project discovery — unlike codex's `skills.config` override, kimi web
 * offers no way to hide auto-discovered skills. A profile therefore narrows
 * availability by adding, never by removing.
 */
export function materializeKimiSkillsDir(
  skillsDir: string,
  selection: SkillSelection,
): MaterializedSkills {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const linked: string[] = [];
  const skipped: string[] = [];
  const taken = new Set(readdirSync(skillsDir));
  for (const entry of selection) {
    if (!entry.enabled) continue;
    if (!isAbsolute(entry.path)) continue;
    const name = basename(entry.path);
    if (taken.has(name)) {
      skipped.push(entry.path);
      continue;
    }
    symlinkSync(entry.path, join(skillsDir, name));
    taken.add(name);
    linked.push(entry.path);
  }
  return { skillsDir, linked, skipped };
}
