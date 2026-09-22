/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ModelCatalog, ProfileCatalog, WorkspaceCatalog } from '../application/ports.js';
import type { BootstrapResponse } from './response.js';
import type { ComponentVersion } from '../../../../shared/contracts/component-version.js';
import type { ProviderAvailability } from '../../../../shared/contracts/llm-provider.js';
export type BootstrapDependencies = {
  workspaces: Pick<WorkspaceCatalog, 'list'>;
  profiles: Pick<ProfileCatalog, 'list'>;
  models?: Pick<ModelCatalog, 'list'>;
  sessions: { list(): unknown[] };
  versions?: readonly ComponentVersion[];
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
  return {
    workspaces,
    profiles,
    models: { codex: codexModels, kimi: kimiModels },
    sessions: deps.sessions.list(),
    versions: deps.versions ?? [],
    capabilities: {
      approvals: true,
      userInput: true,
      git: true,
      protocolCompatible: deps.protocolCompatible,
      providers: deps.providers,
    },
  };
}
