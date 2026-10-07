/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ModelCatalog, ProfileCatalog, WorkspaceCatalog } from '../application/ports.js';
import type { BootstrapResponse } from './response.js';
import type { XerjStatus } from '../../../../shared/contracts/xerj-status.js';
import type { ComponentVersion } from '../../../../shared/contracts/component-version.js';
import type { ProviderAvailability } from '../../../../shared/contracts/llm-provider.js';
export type BootstrapDependencies = {
  xerj?: () => XerjStatus;
  sessionDefaults?: import('../../../../shared/contracts/session-defaults.js').SessionDefaultsStore;
  workspaces: Pick<WorkspaceCatalog, 'list'>;
  profiles: Pick<ProfileCatalog, 'list'>;
  models?: Pick<ModelCatalog, 'list'>;
  sessions: { list(): unknown[] };
  versions?: readonly ComponentVersion[];
  headerIconUrl?: string;
  protocolCompatible: boolean;
  providers: ProviderAvailability;
};
export async function getBootstrap(deps: BootstrapDependencies): Promise<BootstrapResponse> {
  const [workspaces, profiles, codexModels, kimiModels] = await Promise.all([
    deps.workspaces.list(),
    deps.profiles.list(),
    deps.models?.list('codex').catch(() => []) ?? [],
    deps.models?.list('kimi').catch(() => []) ?? [],
  ]);
  let sessionDefaults: BootstrapResponse['sessionDefaults'] = null;
  let sessionDefaultsError = false;
  if (deps.sessionDefaults) {
    try {
      sessionDefaults = await deps.sessionDefaults.read();
    } catch {
      sessionDefaultsError = true;
    }
  }
  return {
    ...(deps.sessionDefaults ? { sessionDefaults, sessionDefaultsError } : {}),
    ...(deps.xerj ? { xerj: deps.xerj() } : {}),
    workspaces,
    profiles,
    models: { codex: codexModels, kimi: kimiModels },
    sessions: deps.sessions.list(),
    versions: deps.versions ?? [],
    branding: { headerIconUrl: deps.headerIconUrl ?? null },
    capabilities: {
      approvals: true,
      userInput: true,
      git: true,
      protocolCompatible: deps.protocolCompatible,
      providers: deps.providers,
    },
  };
}
