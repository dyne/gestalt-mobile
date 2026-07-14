import { RelaySession, type RelaySessionSnapshot } from '../model/relay-session.js';

export async function startSession(
  input: { workspaceId: string; workspacePath: string; profile: string },
  deps: { createId(): string; now(): string; save(session: RelaySessionSnapshot): void },
): Promise<RelaySessionSnapshot> {
  const session = RelaySession.create({
    id: deps.createId(),
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    profile: input.profile,
    now: deps.now(),
  }).snapshot;
  deps.save(session);
  return session;
}
