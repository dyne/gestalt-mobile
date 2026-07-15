export function managedSessionDetails(session: {
  threadId?: string | null;
  workspacePath?: string;
  updatedAt?: string;
}): { threadId: string | null; workspacePath: string; updatedAt: number | null } {
  const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
  return {
    threadId: session.threadId ?? null,
    workspacePath: session.workspacePath ?? 'Workspace unavailable',
    updatedAt: Number.isFinite(timestamp) ? timestamp : null,
  };
}
