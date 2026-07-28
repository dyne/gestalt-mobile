/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';

import type { SkillCatalogResult } from '../../features/skills/model/skill-profile.js';

type Discover = (profile: string, workspace: string) => Promise<SkillCatalogResult>;

/** In-memory editor catalog: discovery runs only when the relay starts or a user refreshes it. */
export class CachedSkillCatalog {
  private readonly entries = new Map<string, SkillCatalogResult>();

  constructor(private readonly discover: Discover) {}

  async list(profile: string, workspace: string): Promise<SkillCatalogResult> {
    return (
      this.entries.get(this.key(profile, workspace)) ?? {
        skills: [],
        errors: [
          {
            message:
              'Skills are not cached for this workspace and Codex profile. Select Refresh skills to discover them.',
          },
        ],
      }
    );
  }

  async refresh(profile: string, workspace: string): Promise<SkillCatalogResult> {
    try {
      const result = await this.discover(profile, workspace);
      this.entries.set(this.key(profile, workspace), result);
      return result;
    } catch {
      const result = {
        skills: [],
        errors: [{ message: 'Skill discovery failed. Select Refresh skills to try again.' }],
      };
      this.entries.set(this.key(profile, workspace), result);
      return result;
    }
  }

  private key(profile: string, workspace: string): string {
    return `${profile}\u0000${resolve(workspace)}`;
  }
}
