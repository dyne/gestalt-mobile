import { RelaySession, type RelaySessionSnapshot } from '../model/relay-session.js';
import type { ProfileCatalog, WorkspaceCatalog } from '../../catalog/application/ports.js';

export async function startSession(
  input: { workspaceId: string; profile: string },
  deps: {
    createId(): string;
    now(): string;
    save(session: RelaySessionSnapshot): void;
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    profiles: Pick<ProfileCatalog, 'require'>;
    activate?(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot>;
  },
): Promise<RelaySessionSnapshot> {
  const [workspace] = await Promise.all([
    deps.workspaces.resolve(input.workspaceId),
    deps.profiles.require(input.profile),
  ]);
  const session = RelaySession.create({
    id: deps.createId(),
    workspaceId: workspace.id,
    workspacePath: workspace.realPath,
    profile: input.profile,
    now: deps.now(),
  }).snapshot;
  deps.save(session);
  if (!deps.activate) return session;
  const active = await deps.activate(session);
  deps.save(active);
  return active;
}
