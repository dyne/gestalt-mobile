export function createRelayClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, body: unknown): Promise<unknown> {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('RELAY_REQUEST_FAILED');
    return response.json();
  }
  async function get(path: string): Promise<unknown> {
    const response = await fetcher(path);
    if (!response.ok) throw new Error('RELAY_REQUEST_FAILED');
    return response.json();
  }

  return {
    listSessions: () => get('/api/sessions'),
    startSession: (workspaceId: string, profile: string) =>
      request('/api/sessions', { workspaceId, profile }),
    startTurn: (sessionId: string, text: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, { text }),
    interruptTurn: (sessionId: string, turnId: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/interrupt`, {}),
    restoreSession: (sessionId: string) =>
      request(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {}),
    getHistory: (sessionId: string) => get(`/api/sessions/${encodeURIComponent(sessionId)}/history`),
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
