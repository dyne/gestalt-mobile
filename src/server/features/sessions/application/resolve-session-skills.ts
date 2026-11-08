/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LlmProvider } from '../../../../shared/contracts/llm-provider.js';
import {
  createEffectiveSkillSelection,
  type EffectiveSkillSelection,
} from '../model/relay-session.js';
import type { SkillCatalog, SkillProfileStore } from '../../skills/application/ports.js';
import {
  reconcileSkillSelectionSnapshot,
  type SkillProfile,
} from '../../skills/model/skill-profile.js';
import { SkillProfileError } from '../../skills/model/errors.js';

/** Same immutable profile/capability snapshot for ordinary starts and read-only preparation. */
export async function resolveSessionSkillSelection(
  input: { workspacePath: string; provider: LlmProvider; profile: string; skillProfile?: string },
  deps: {
    skillProfiles: Pick<SkillProfileStore, 'readGlobalProfile' | 'readWorkspaceDefault'>;
    skillCatalog(provider: LlmProvider, profile: string): Pick<SkillCatalog, 'list'>;
    defaultSkillProfile?: SkillProfile;
  },
): Promise<EffectiveSkillSelection> {
  const selectedProfile = input.skillProfile
    ? await deps.skillProfiles.readGlobalProfile(input.skillProfile)
    : deps.defaultSkillProfile;
  if (input.skillProfile && !selectedProfile)
    throw new SkillProfileError(
      'UNKNOWN_SKILL_PROFILE',
      'The selected skill profile does not exist.',
    );
  const [projectProfile, catalog] = await Promise.all([
    deps.skillProfiles.readWorkspaceDefault(input.workspacePath),
    deps.skillCatalog(input.provider, input.profile).list(input.workspacePath),
  ]);
  const sourceProfile = selectedProfile ?? projectProfile;
  const reconciled = reconcileSkillSelectionSnapshot(catalog.skills, sourceProfile?.skills);
  return createEffectiveSkillSelection({
    ...(sourceProfile?.capabilities ? { capabilities: sourceProfile.capabilities } : {}),
    ...(selectedProfile ? { selectedProfileName: selectedProfile.name } : {}),
    skills: [
      ...reconciled.skills.map((skill) => ({
        name: skill.name,
        path: skill.path,
        enabled: skill.enabled,
      })),
      ...reconciled.missing,
    ],
    ...(reconciled.warnings.length ? { warnings: reconciled.warnings } : {}),
  });
}
