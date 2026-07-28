/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySession } from '../sessions/relay-client.js';

export type WorkspaceOption = {
  id: string;
  name: string;
  relativePath: string;
  isGitRepository: boolean;
  children: WorkspaceOption[];
};

export type Bootstrap = {
  workspaces: WorkspaceOption[];
  profiles: Array<{ name: string; state: 'ok' | 'not_logged_in' | 'error'; status: string }>;
  sessions: RelaySession[];
  capabilities: {
    approvals: true;
    userInput: true;
    git: true;
    protocolCompatible: boolean;
  };
};

export function flattenWorkspaceTree(roots: WorkspaceOption[]): WorkspaceOption[] {
  const flattened: WorkspaceOption[] = [];
  const visit = (node: WorkspaceOption): void => {
    flattened.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return flattened;
}

const bootstrapRetryDelays = [150, 300, 600] as const;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldRetryBootstrap(response: Response): boolean {
  return response.status === 502 || response.status === 503 || response.status === 504;
}

export async function loadBootstrap(fetcher: typeof fetch = fetch): Promise<Bootstrap> {
  for (let attempt = 0; attempt <= bootstrapRetryDelays.length; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher('/api/bootstrap');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (attempt === bootstrapRetryDelays.length) throw new Error('BOOTSTRAP_FAILED');
      await wait(bootstrapRetryDelays[attempt]);
      continue;
    }
    if (response.ok) return response.json() as Promise<Bootstrap>;
    if (!shouldRetryBootstrap(response) || attempt === bootstrapRetryDelays.length)
      throw new Error('BOOTSTRAP_FAILED');
    await wait(bootstrapRetryDelays[attempt]);
  }
  throw new Error('BOOTSTRAP_FAILED');
}
