/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ModelCatalog, ProfileCatalog, WorkspaceCatalog } from '../application/ports.js';
import type { BootstrapResponse } from './response.js';
export type BootstrapDependencies = {
  workspaces: Pick<WorkspaceCatalog, 'list'>;
  profiles: Pick<ProfileCatalog, 'list'>;
  models?: Pick<ModelCatalog, 'list'>;
  sessions: { list(): unknown[] };
  protocolCompatible: boolean;
};
export async function getBootstrap(deps: BootstrapDependencies): Promise<BootstrapResponse> {
  const [workspaces, profiles, models] = await Promise.all([
    deps.workspaces.list(),
    deps.profiles.list(),
    deps.models?.list().catch(() => []) ?? [],
  ]);
  return {
    workspaces,
    profiles,
    models,
    sessions: deps.sessions.list(),
    capabilities: {
      approvals: true,
      userInput: true,
      git: true,
      protocolCompatible: deps.protocolCompatible,
    },
  };
}
