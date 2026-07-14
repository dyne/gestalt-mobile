import type { ProfileCatalog, WorkspaceCatalog } from '../application/ports.js';
import type { BootstrapResponse } from './response.js';
export type BootstrapDependencies = {
  workspaces: Pick<WorkspaceCatalog, 'list'>;
  profiles: Pick<ProfileCatalog, 'list'>;
  sessions: { list(): unknown[] };
  protocolCompatible: boolean;
};
export async function getBootstrap(deps: BootstrapDependencies): Promise<BootstrapResponse> {
  const [workspaces, profiles] = await Promise.all([deps.workspaces.list(), deps.profiles.list()]);
  return {
    workspaces,
    profiles,
    sessions: deps.sessions.list(),
    capabilities: {
      approvals: true,
      userInput: true,
      git: true,
      protocolCompatible: deps.protocolCompatible,
    },
  };
}
