/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

import type { SkillCatalog } from '../../features/skills/application/ports.js';
import type { SkillCatalogResult } from '../../features/skills/model/skill-profile.js';

/**
 * Make the optional collection available to providers that do not discover
 * Codex home. This is ordinary filesystem discovery: receipt/integrity failures
 * affect provenance independently, never whether a user can select a skill.
 */
export class ManagedSkillCatalog implements SkillCatalog {
  constructor(private readonly codexHome: string) {}

  async list(): Promise<SkillCatalogResult> {
    const skills: SkillCatalogResult['skills'] = [];
    const root = join(this.codexHome, 'gestalt-skills', 'skills');
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
        try {
          const path = await realpath(join(root, entry.name, 'SKILL.md'));
          const text = await readFile(path, 'utf8');
          const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
          if (!frontmatter) continue;
          const document = parseDocument(frontmatter[1], { strict: true, uniqueKeys: true });
          if (document.errors.length) continue;
          const metadata = document.toJS() as { name?: unknown; description?: unknown } | null;
          if (metadata?.name !== entry.name) continue;
          skills.push({
            name: entry.name,
            path,
            enabled: true,
            scope: 'user',
            ...(typeof metadata.description === 'string'
              ? { description: metadata.description }
              : {}),
          });
        } catch {
          // A missing/invalid entry cannot suppress other installed skills.
        }
      }
    } catch {
      // The optional collection may not be installed.
    }
    return {
      skills: skills.sort((left, right) => left.path.localeCompare(right.path)),
      errors: [],
    };
  }
}
