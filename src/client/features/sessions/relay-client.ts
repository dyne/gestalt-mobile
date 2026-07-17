export type RelaySession = {
  id: string;
  state: string;
  workspaceId?: string;
  workspacePath?: string;
  profile?: string;
  threadId?: string | null;
  resumeCommand?: string | null;
  activeTurnId?: string | null;
  pendingInteractions?: Array<{ requestId: string; kind: string; payload: unknown }>;
  createdAt?: string;
  updatedAt?: string;
};
export type RecentSession = { id: string; cwd: string; recencyAt: number | null };
export type StartSessionSettings = {
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
};

export type RelayHistoryItem = Record<string, unknown> & {
  id: string;
  kind: string;
  text?: string;
  occurredAt?: number;
};
export type RelayHistory = {
  items: RelayHistoryItem[];
  activeTurnId?: string | null;
  currentSequence?: number;
};
export type RelayGitSummary = {
  available: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: { staged: number; unstaged: number; untracked: number };
  commits: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    authoredAt: string;
  }>;
  fetchedAt: string | null;
};

export function createRelayClient(fetcher: typeof fetch = fetch) {
  async function failure(response: Response): Promise<Error> {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      title?: unknown;
    } | null;
    const message =
      typeof body?.detail === 'string'
        ? body.detail
        : typeof body?.title === 'string'
          ? body.title
          : `Relay request failed (${response.status}).`;
    return new Error(message);
  }
  async function request<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }
  async function get<T>(path: string): Promise<T> {
    const response = await fetcher(path);
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }

  return {
    listSessions: () => get<RelaySession[]>('/api/sessions'),
    listRecentSessions: () => get<RecentSession[]>('/api/sessions/recent-threads'),
    startSession: (
      workspaceId: string,
      settings: StartSessionSettings = {},
      key?: string,
    ) =>
      request<RelaySession>(
        '/api/sessions',
        { workspaceId, profile: 'default', ...settings },
        key ? { 'idempotency-key': key } : {},
      ),
    startTurn: (sessionId: string, text: string) =>
      request<{ activeTurnId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
        text,
      }),
    interruptTurn: (sessionId: string, turnId: string) =>
      request<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
        {},
      ),
    restoreSession: (sessionId: string) =>
      request<RelaySession>(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {}),
    releaseSession: (sessionId: string) =>
      request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/release`, {}),
    forgetSession: (sessionId: string) =>
      fetcher(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).then(
        async (response) => {
          if (!response.ok) throw await failure(response);
        },
      ),
    getHistory: (sessionId: string) =>
      get<RelayHistory>(`/api/sessions/${encodeURIComponent(sessionId)}/history`),
    getGitSummary: (sessionId: string) =>
      get<RelayGitSummary>(`/api/sessions/${encodeURIComponent(sessionId)}/git`),
    refreshGit: (sessionId: string, key?: string) =>
      request<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/refresh`,
        {},
        key ? { 'idempotency-key': key } : {},
      ),
    pushGit: (sessionId: string, key?: string) =>
      request<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/push`,
        {},
        key ? { 'idempotency-key': key } : {},
      ),
    respondInteraction: (sessionId: string, requestId: string, value: unknown) =>
      request<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(requestId)}`,
        value,
      ),
  };
}
