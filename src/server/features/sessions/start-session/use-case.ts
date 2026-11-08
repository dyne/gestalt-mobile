/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  RelaySession,
  type RelaySessionSnapshot,
  type EffectiveSkillSelection,
} from '../model/relay-session.js';
import type { ProfileCatalog, WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { ModelCatalog } from '../../catalog/application/ports.js';
import { DEFAULT_SESSION_MODEL, type StartSessionSettings } from '../application/start-settings.js';
import type { SkillCatalog, SkillProfileStore } from '../../skills/application/ports.js';
import type { SkillProfile } from '../../skills/model/skill-profile.js';
import type { LlmProvider } from '../../../../shared/contracts/llm-provider.js';
import { defaultProviderModel } from '../../../../shared/contracts/session-defaults.js';
import { resolveSessionSkillSelection } from '../application/resolve-session-skills.js';

export async function startSession(
  input: { workspaceId: string; profile: string; skillProfile?: string } & StartSessionSettings,
  deps: {
    createId(): string;
    now(): string;
    save(session: RelaySessionSnapshot): void;
    publish?(session: RelaySessionSnapshot): Promise<void>;
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    profiles: Pick<ProfileCatalog, 'require'>;
    models?: Pick<ModelCatalog, 'list'>;
    /** Explicit session setup may resolve a provider catalog that passive bootstrap cannot start. */
    sessionModels?: Pick<ModelCatalog, 'list'>;
    gitBranch?(workspacePath: string): Promise<string | null>;
    skillProfiles: Pick<SkillProfileStore, 'readGlobalProfile' | 'readWorkspaceDefault'>;
    skillCatalog(provider: LlmProvider, profile: string): Pick<SkillCatalog, 'list'>;
    defaultSkillProfile?: SkillProfile;
    /** Internal independent sessions may inherit an existing immutable selection. */
    inheritedSkillSelection?: EffectiveSkillSelection;
    activate?(
      session: RelaySessionSnapshot,
      settings: StartSessionSettings,
    ): Promise<RelaySessionSnapshot>;
  },
): Promise<RelaySessionSnapshot> {
  // Codex launcher profiles select the app-server skill directory. Kimi owns
  // its isolated profile lifecycle, so it must not require a Codex launcher
  // profile before its own catalog/runtime can be selected.
  const [workspace] = await Promise.all([
    deps.workspaces.resolve(input.workspaceId),
    ...(input.provider === 'codex' ? [deps.profiles.require(input.profile)] : []),
  ]);
  let model = input.model;
  const modelCatalog = deps.sessionModels ?? deps.models;
  if (modelCatalog) {
    const models = await modelCatalog.list(input.provider);
    // An omitted model resolves to the provider's own default: the relay-wide
    // default when that provider serves it, otherwise the provider's first
    // available model, so a kimi request never inherits the codex default.
    model ??= defaultProviderModel(input.provider, models);
    if (!models.includes(model))
      throw new Error(
        input.provider === 'codex' ? 'CODEX_MODEL_UNAVAILABLE' : 'KIMI_MODEL_UNAVAILABLE',
      );
    if (input.provider === 'codex' && input.executorModel && !models.includes(input.executorModel))
      throw new Error('CODEX_EXECUTOR_MODEL_UNAVAILABLE');
  } else {
    model ??= DEFAULT_SESSION_MODEL;
  }
  const effectiveSkillSelection =
    deps.inheritedSkillSelection ??
    (await resolveSessionSkillSelection({ ...input, workspacePath: workspace.realPath }, deps));
  const branch = await deps.gitBranch?.(workspace.realPath);
  const session = RelaySession.create({
    id: deps.createId(),
    workspaceId: workspace.id,
    workspacePath: workspace.realPath,
    provider: input.provider,
    profile: input.profile,
    model,
    ...(input.provider === 'codex' &&
    (input.reasoningEffort || input.executorModel || input.executorReasoningEffort)
      ? {
          modelSettings: {
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            ...(input.executorModel ? { executorModel: input.executorModel } : {}),
            ...(input.executorReasoningEffort
              ? { executorReasoningEffort: input.executorReasoningEffort }
              : {}),
          },
        }
      : {}),
    ...(branch ? { branch } : {}),
    sandbox: input.sandbox,
    approvalPolicy: input.approvalPolicy,
    effectiveSkillSelection,
    now: deps.now(),
  }).snapshot;
  if (deps.publish) await deps.publish(session);
  else deps.save(session);
  if (!deps.activate) return session;
  const active = await deps.activate(session, { provider: session.provider });
  deps.save(active);
  return active;
}
