/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { RelaySession, type RelaySessionSnapshot } from '../model/relay-session.js';
import type { ProfileCatalog, WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { ModelCatalog } from '../../catalog/application/ports.js';
import { DEFAULT_SESSION_MODEL, type StartSessionSettings } from '../application/start-settings.js';
import type { SkillCatalog, SkillProfileStore } from '../../skills/application/ports.js';
import {
  reconcileSkillSelectionSnapshot,
  type SkillProfile,
} from '../../skills/model/skill-profile.js';
import { SkillProfileError } from '../../skills/model/errors.js';

export async function startSession(
  input: { workspaceId: string; profile: string; skillProfile?: string } & StartSessionSettings,
  deps: {
    createId(): string;
    now(): string;
    save(session: RelaySessionSnapshot): void;
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    profiles: Pick<ProfileCatalog, 'require'>;
    models?: Pick<ModelCatalog, 'list'>;
    gitBranch?(workspacePath: string): Promise<string | null>;
    skillProfiles: Pick<SkillProfileStore, 'readGlobalProfile' | 'readWorkspaceDefault'>;
    skillCatalog(profile: string): Pick<SkillCatalog, 'list'>;
    defaultSkillProfile?: SkillProfile;
    activate?(
      session: RelaySessionSnapshot,
      settings: StartSessionSettings,
    ): Promise<RelaySessionSnapshot>;
  },
): Promise<RelaySessionSnapshot> {
  const [workspace] = await Promise.all([
    deps.workspaces.resolve(input.workspaceId),
    deps.profiles.require(input.profile),
  ]);
  let model = input.model;
  if (deps.models) {
    const models = await deps.models.list(input.provider);
    // An omitted model resolves to the provider's own default: the relay-wide
    // default when that provider serves it, otherwise the provider's first
    // available model, so a kimi request never inherits the codex default.
    model ??= models.includes(DEFAULT_SESSION_MODEL)
      ? DEFAULT_SESSION_MODEL
      : (models[0] ?? DEFAULT_SESSION_MODEL);
    if (!models.includes(model))
      throw new Error(
        input.provider === 'codex' ? 'CODEX_MODEL_UNAVAILABLE' : 'KIMI_MODEL_UNAVAILABLE',
      );
  } else {
    model ??= DEFAULT_SESSION_MODEL;
  }
  const selectedProfile = input.skillProfile
    ? await deps.skillProfiles.readGlobalProfile(input.skillProfile)
    : deps.defaultSkillProfile;
  if (input.skillProfile && !selectedProfile)
    throw new SkillProfileError(
      'UNKNOWN_SKILL_PROFILE',
      'The selected skill profile does not exist.',
    );
  const [projectProfile, catalog] = await Promise.all([
    deps.skillProfiles.readWorkspaceDefault(workspace.realPath),
    deps.skillCatalog(input.profile).list(workspace.realPath),
  ]);
  const sourceProfile = selectedProfile ?? projectProfile;
  const reconciledSkills = reconcileSkillSelectionSnapshot(catalog.skills, sourceProfile?.skills);
  const effectiveSkillSelection = {
    ...(selectedProfile ? { selectedProfileName: selectedProfile.name } : {}),
    skills: [
      ...reconciledSkills.skills.map((skill) => ({
        name: skill.name,
        path: skill.path,
        enabled: skill.enabled,
      })),
      ...reconciledSkills.missing,
    ],
    ...(reconciledSkills.warnings.length > 0 ? { warnings: reconciledSkills.warnings } : {}),
  };
  const branch = await deps.gitBranch?.(workspace.realPath);
  const session = RelaySession.create({
    id: deps.createId(),
    workspaceId: workspace.id,
    workspacePath: workspace.realPath,
    provider: input.provider,
    profile: input.profile,
    model,
    ...(branch ? { branch } : {}),
    sandbox: input.sandbox,
    approvalPolicy: input.approvalPolicy,
    effectiveSkillSelection,
    now: deps.now(),
  }).snapshot;
  deps.save(session);
  if (!deps.activate) return session;
  const active = await deps.activate(session, { provider: session.provider });
  deps.save(active);
  return active;
}
