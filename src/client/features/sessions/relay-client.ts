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
  async function request(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return response.json();
  }
  async function get(path: string): Promise<unknown> {
    const response = await fetcher(path);
    if (!response.ok) throw await failure(response);
    return response.json();
  }

  return {
    listSessions: () => get('/api/sessions'),
    startSession: (workspaceId: string, profile: string, key?: string) =>
      request('/api/sessions', { workspaceId, profile }, key ? { 'idempotency-key': key } : {}),
    startTurn: (sessionId: string, text: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, { text }),
    interruptTurn: (sessionId: string, turnId: string) =>
      request(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
        {},
      ),
    restoreSession: (sessionId: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {}),
    releaseSession: (sessionId: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/release`, {}),
    getHistory: (sessionId: string) =>
      get(`/api/sessions/${encodeURIComponent(sessionId)}/history`),
    getGitSummary: (sessionId: string) => get(`/api/sessions/${encodeURIComponent(sessionId)}/git`),
    refreshGit: (sessionId: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/git/refresh`, {}),
    pushGit: (sessionId: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/git/push`, {}),
    respondInteraction: (sessionId: string, requestId: string, value: unknown) =>
      request(
        `/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(requestId)}`,
        value,
      ),
  };
}
