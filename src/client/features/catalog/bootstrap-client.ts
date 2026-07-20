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

export async function loadBootstrap(fetcher: typeof fetch = fetch): Promise<Bootstrap> {
  const response = await fetcher('/api/bootstrap');
  if (!response.ok) throw new Error('BOOTSTRAP_FAILED');
  return response.json() as Promise<Bootstrap>;
}
