import type { ProfileOption, WorkspaceOption } from '../application/ports.js';
export type BootstrapResponse = {
  workspaces: WorkspaceOption[];
  profiles: ProfileOption[];
  sessions: unknown[];
  capabilities: { approvals: true; userInput: true; git: true; protocolCompatible: boolean };
};
