/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';

import type { LlmProvider } from '../../../shared/contracts/llm-provider.js';
import type { SkillCatalogResult } from '../../features/skills/model/skill-profile.js';
import type { SkillProvenanceVerifier } from '../../features/skills/application/ports.js';
import { verifySkillProvenance } from './verified-skill-catalog.js';

type Discover = (
  provider: LlmProvider,
  profile: string,
  workspace: string,
) => Promise<SkillCatalogResult>;

/** In-memory editor catalog: discovery runs only when the relay starts or a user refreshes it. */
export class CachedSkillCatalog {
  private readonly entries = new Map<string, SkillCatalogResult>();

  constructor(
    private readonly discover: Discover,
    private readonly validate?: (
      provider: LlmProvider,
      profile: string,
      workspace: string,
      result: SkillCatalogResult,
    ) => Promise<SkillCatalogResult>,
    private readonly provenance?: SkillProvenanceVerifier,
  ) {}

  async list(
    provider: LlmProvider,
    profile: string,
    workspace: string,
  ): Promise<SkillCatalogResult> {
    const result = this.entries.get(this.key(provider, profile, workspace)) ?? {
      skills: [],
      errors: [
        {
          message:
            'Skills are not cached for this workspace and profile. Select Refresh skills to discover them.',
        },
      ],
    };
    // Validation is a live capability projection over the last discovered
    // catalog. Keep the discovery baseline so a transient outage can recover
    // on the next list without requiring package rediscovery.
    const current = this.validate
      ? await this.validate(provider, profile, workspace, result)
      : result;
    return this.provenance ? verifySkillProvenance(current, this.provenance) : current;
  }

  async refresh(
    provider: LlmProvider,
    profile: string,
    workspace: string,
  ): Promise<SkillCatalogResult> {
    try {
      const result = await this.discover(provider, profile, workspace);
      this.entries.set(this.key(provider, profile, workspace), result);
      return this.provenance ? verifySkillProvenance(result, this.provenance) : result;
    } catch {
      const result = {
        skills: [],
        errors: [{ message: 'Skill discovery failed. Select Refresh skills to try again.' }],
      };
      this.entries.set(this.key(provider, profile, workspace), result);
      return result;
    }
  }

  private key(provider: LlmProvider, profile: string, workspace: string): string {
    return `${provider}\u0000${profile}\u0000${resolve(workspace)}`;
  }
}
