/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  SkillCatalog,
  SkillProvenanceVerifier,
} from '../../features/skills/application/ports.js';
import type {
  AvailableSkill,
  SkillCatalogResult,
} from '../../features/skills/model/skill-profile.js';

/** Discard supplied metadata before projecting current server-owned verification. */
export async function verifySkillProvenance(
  result: SkillCatalogResult,
  verifier: SkillProvenanceVerifier,
): Promise<SkillCatalogResult> {
  const verified = await verifier.verify(result.skills.map((skill) => skill.path));
  return {
    ...result,
    skills: result.skills.map((skill): AvailableSkill => {
      const ordinary = { ...skill };
      delete ordinary.provenance;
      const provenance = verified.get(skill.path);
      return { ...ordinary, ...(provenance ? { provenance } : {}) };
    }),
  };
}

/** Provider-neutral decoration after each provider has parsed its wire response. */
export class VerifiedSkillCatalog implements SkillCatalog {
  constructor(
    private readonly catalog: SkillCatalog,
    private readonly verifier: SkillProvenanceVerifier,
  ) {}

  async list(workspace: string): Promise<SkillCatalogResult> {
    return verifySkillProvenance(await this.catalog.list(workspace), this.verifier);
  }
}
