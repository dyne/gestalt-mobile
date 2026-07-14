import type { RelaySession } from '../sessions/relay-client.js';

export type Bootstrap = {
  workspaces: Array<{ id: string; name: string }>;
  profiles: Array<{ name: string; state: 'ok' | 'not_logged_in' | 'error'; status: string }>;
  sessions: RelaySession[];
};

export async function loadBootstrap(fetcher: typeof fetch = fetch): Promise<Bootstrap> {
  const response = await fetcher('/api/bootstrap');
  if (!response.ok) throw new Error('BOOTSTRAP_FAILED');
  return response.json() as Promise<Bootstrap>;
}
