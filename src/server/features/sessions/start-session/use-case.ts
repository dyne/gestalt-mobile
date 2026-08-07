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
  applySkillSelectionSnapshot,
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
  const model = input.model ?? DEFAULT_SESSION_MODEL;
  const [workspace] = await Promise.all([
    deps.workspaces.resolve(input.workspaceId),
    deps.profiles.require(input.profile),
  ]);
  if (deps.models) {
    const models = await deps.models.list();
    if (!models.includes(model)) throw new Error('CODEX_MODEL_UNAVAILABLE');
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
  const effectiveSkillSelection = {
    ...(selectedProfile ? { selectedProfileName: selectedProfile.name } : {}),
    skills: applySkillSelectionSnapshot(catalog.skills, sourceProfile?.skills).map((skill) => ({
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    })),
  };
  const branch = await deps.gitBranch?.(workspace.realPath);
  const session = RelaySession.create({
    id: deps.createId(),
    workspaceId: workspace.id,
    workspacePath: workspace.realPath,
    profile: input.profile,
    model,
    ...(branch ? { branch } : {}),
    effectiveSkillSelection,
    now: deps.now(),
  }).snapshot;
  deps.save(session);
  if (!deps.activate) return session;
  const active = await deps.activate(session, {
    model,
    sandbox: input.sandbox,
    approvalPolicy: input.approvalPolicy,
  });
  deps.save(active);
  return active;
}
