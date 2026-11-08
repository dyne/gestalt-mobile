/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  sessionDefaultsSchema,
  resolveNewSessionDefaults,
  type SessionDefaultsStore,
} from '../../../../shared/contracts/session-defaults.js';
import type {
  OrgPlanLaunchSettings,
  OrgPlanSkillProfileOption,
} from '../../../../shared/contracts/org-plan-execution.js';
import type { ModelCatalog, ProfileCatalog } from '../../catalog/application/ports.js';
import type { SkillCatalog, SkillProfileStore } from '../../skills/application/ports.js';
import type { SkillProfile } from '../../skills/model/skill-profile.js';
import { readGlobalSkillProfiles } from '../../skills/application/read-global-profiles.js';
import { resolveSessionSkillSelection } from '../../sessions/application/resolve-session-skills.js';
import type { EffectiveSkillSelection } from '../../sessions/model/relay-session.js';

export type OrgPlanSettingsRead =
  | {
      kind: 'available';
      settings: OrgPlanLaunchSettings;
      skillProfiles: readonly OrgPlanSkillProfileOption[];
      warnings: readonly string[];
      effectiveSkillSelection: EffectiveSkillSelection;
    }
  | {
      kind: 'unavailable';
      code:
        | 'SESSION_DEFAULTS_UNAVAILABLE'
        | 'MODEL_UNAVAILABLE'
        | 'SKILL_PROFILE_UNAVAILABLE'
        | 'GESTALT_CAPABILITIES_UNAVAILABLE';
      reason: string;
    };

export type OrgPlanSettingsDependencies = {
  defaults: Pick<SessionDefaultsStore, 'read'>;
  models: Pick<ModelCatalog, 'list'>;
  profiles: Pick<ProfileCatalog, 'require'>;
  skillProfiles: Pick<
    SkillProfileStore,
    'listGlobalProfileNames' | 'readGlobalProfile' | 'readWorkspaceDefault'
  >;
  skillCatalog(provider: 'codex' | 'kimi', profile: string): Pick<SkillCatalog, 'list'>;
  defaultSkillProfile?: SkillProfile;
};

/** Read-only counterpart of the ordinary New session form and skill snapshot. */
export async function prepareOrgPlanSettings(
  workspacePath: string,
  deps: OrgPlanSettingsDependencies,
  skillProfile?: string,
): Promise<OrgPlanSettingsRead> {
  const unavailable = (
    code: Extract<OrgPlanSettingsRead, { kind: 'unavailable' }>['code'],
    reason: string,
  ): OrgPlanSettingsRead => ({ kind: 'unavailable', code, reason });
  let saved;
  try {
    const read = await deps.defaults.read();
    saved = read === null ? null : sessionDefaultsSchema.parse(read);
  } catch {
    return unavailable(
      'SESSION_DEFAULTS_UNAVAILABLE',
      'Saved New session defaults could not be read. Refresh after repairing them.',
    );
  }
  let models: string[];
  try {
    models = await deps.models.list('codex');
  } catch {
    return unavailable(
      'MODEL_UNAVAILABLE',
      'The Codex model catalog is unavailable. Refresh and retry.',
    );
  }
  const defaults = resolveNewSessionDefaults(saved, 'codex', models);
  if (!models.includes(defaults.model) || !models.includes(defaults.executorModel))
    return unavailable(
      'MODEL_UNAVAILABLE',
      'The saved supervisor or executor model is unavailable in Codex. Update New session defaults and retry.',
    );
  try {
    await deps.profiles.require('default');
    const entries = await readGlobalSkillProfiles(deps.skillProfiles);
    const warnings: string[] = [];
    let selected = skillProfile ?? defaults.skillProfile;
    const valid = (name: string) =>
      entries.some((entry) => entry.name === name && 'profile' in entry);
    if (selected && !valid(selected)) {
      if (skillProfile !== undefined)
        return unavailable(
          'SKILL_PROFILE_UNAVAILABLE',
          'The selected supervisor skill profile disappeared or is invalid. Refresh and choose again.',
        );
      warnings.push(
        'The saved skill profile is unavailable. Default is selected; choose a supervisor profile before confirming.',
      );
      selected = '';
    }
    const effectiveSkillSelection = await resolveSessionSkillSelection(
      {
        workspacePath,
        provider: 'codex',
        profile: 'default',
        ...(selected ? { skillProfile: selected } : {}),
      },
      deps,
    );
    if (
      !effectiveSkillSelection.skills.some(
        (skill) => skill.name === 'gestalt:org-plan' && skill.enabled,
      )
    )
      return unavailable(
        'GESTALT_CAPABILITIES_UNAVAILABLE',
        'The Org-plan skill is unavailable in the ordinary Codex session catalog. Restore Gestalt capabilities and retry.',
      );
    const { workspaceId: _workspaceId, ...settings } = defaults;
    void _workspaceId;
    return {
      kind: 'available',
      settings: { ...settings, provider: 'codex', profile: 'default', skillProfile: selected },
      effectiveSkillSelection,
      skillProfiles: entries.map((entry) => ({
        name: entry.name,
        ...('error' in entry ? { error: entry.error.message } : {}),
      })),
      warnings: [...warnings, ...(effectiveSkillSelection.warnings ?? [])],
    };
  } catch {
    return unavailable(
      'SKILL_PROFILE_UNAVAILABLE',
      'Supervisor profiles or workspace skills could not be read. Refresh and retry.',
    );
  }
}
