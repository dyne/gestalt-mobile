/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from '../plans/contracts.js';

export type WorkspacePlanEntry = Readonly<{
  planName: string;
  title: string;
  subtitle?: string;
  date?: string;
  keywords?: string;
  totalSteps: number;
  doneSteps: number;
  allDone: boolean;
}>;

export type RelaySession = {
  id: string;
  state: string;
  workspaceId?: string;
  workspacePath?: string;
  profile?: string;
  model?: string;
  branch?: string;
  threadId?: string | null;
  resumeCommand?: string | null;
  activeTurnId?: string | null;
  pendingInteractions?: Array<{ requestId: string; kind: string; payload: unknown }>;
  createdAt?: string;
  updatedAt?: string;
  effectiveSkillSelection?: {
    selectedProfileName?: string;
    skills: Array<{ name: string; path: string; enabled: boolean }>;
  };
  lastOrgPlan?: { filename: string; title: string };
};
export type RestoreSessionResult = RelaySession & {
  recovery?: { historyUnavailable: true; replacementCreated: true };
};
export type RecentSession = {
  id: string;
  cwd: string;
  recencyAt: number | null;
  resumeCommand: string;
  model?: string;
  skillProfile?: string;
  orgPlanFilename?: string;
};
export type StartSessionSettings = {
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  skillProfile?: string;
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
  branches?: string[];
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

export type RelayAvailableSkill = {
  name: string;
  description?: string;
  shortDescription?: string;
  displayName?: string;
  interfaceShortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
  dependencies?: { tools?: Array<{ type: string; value: string; description?: string; transport?: string; command?: string; url?: string }> };
  path: string;
  scope?: string;
  nativeEnabled: boolean;
  effectiveEnabled: boolean;
};

export type RelaySkillList = {
  source: 'native' | 'project';
  errors: Array<{ message: string }>;
  skills: RelayAvailableSkill[];
};

export type RelaySkillProfile = {
  version: 1;
  name: string;
  path: string;
  skills: Array<{ name: string; path: string; enabled: boolean }>;
};

export type RelaySkillProfileList = {
  profiles: Array<
    | RelaySkillProfile
    | { name: string; path: string; error: { code: 'INVALID_SKILL_PROFILE'; message: string } }
  >;
};

export function createRelayClient(fetcher: typeof fetch = fetch) {
  async function failure(response: Response): Promise<Error> {
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      detail?: unknown;
      title?: unknown;
    } | null;
    const message =
      typeof body?.detail === 'string'
        ? body.detail
        : typeof body?.title === 'string'
          ? body.title
          : `Relay request failed (${response.status}).`;
    return Object.assign(new Error(message), {
      ...(typeof body?.code === 'string' && /^[A-Z0-9_]+$/.test(body.code)
        ? { code: body.code }
        : {}),
    });
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
  async function put<T>(path: string, body: unknown): Promise<T> {
    const response = await fetcher(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }
  async function remove(path: string): Promise<void> {
    const response = await fetcher(path, { method: 'DELETE' });
    if (!response.ok) throw await failure(response);
  }
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetcher(path, signal ? { signal } : undefined);
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }
  async function getOptional<T>(path: string, signal: AbortSignal): Promise<T | null> {
    const response = await fetcher(path, { signal });
    if (response.status === 204) return null;
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }

  return {
    listSessions: () => get<RelaySession[]>('/api/sessions'),
    listRecentSessions: () => get<RecentSession[]>('/api/sessions/recent-threads'),
    openRecentSession: (threadId: string, cwd: string) =>
      request<RelaySession>('/api/sessions/recent-threads/open', { threadId, cwd }),
    startSession: (workspaceId: string, settings: StartSessionSettings = {}, key?: string) =>
      request<RelaySession>(
        '/api/sessions',
        { workspaceId, profile: 'default', ...settings },
        key ? { 'idempotency-key': key } : {},
      ),
    startTurn: (sessionId: string, text: string) =>
      request<{ activeTurnId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
        text,
      }),
    selectModel: (sessionId: string, model: string) =>
      request<RelaySession>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, { model }),
    interruptTurn: (sessionId: string, turnId: string) =>
      request<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
        {},
      ),
    restoreSession: (sessionId: string) =>
      request<RestoreSessionResult>(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {}),
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
    getPlan: (sessionId: string, signal: AbortSignal) =>
      getOptional<SupervisedPlan>(`/api/sessions/${encodeURIComponent(sessionId)}/plan`, signal),
    closePlan: (sessionId: string) =>
      remove(`/api/sessions/${encodeURIComponent(sessionId)}/plan`),
    listWorkspacePlans: (workspaceId: string, signal?: AbortSignal) =>
      get<WorkspacePlanEntry[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/plans`, signal),
    getWorkspacePlan: (workspaceId: string, planName: string, signal?: AbortSignal) =>
      get<SupervisedPlan>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planName)}`,
        signal,
      ),
    getGitSummary: (workspaceId: string) =>
      get<RelayGitSummary>(`/api/git/repositories/${encodeURIComponent(workspaceId)}`),
    cloneGitRepository: (workspaceId: string, address: string) =>
      request<void>('/api/git/clone', { workspaceId, address }),
    refreshGit: (workspaceId: string, key?: string) =>
      request<void>(
        `/api/git/repositories/${encodeURIComponent(workspaceId)}/refresh`,
        {},
        key ? { 'idempotency-key': key } : {},
      ),
    pullGit: (workspaceId: string, key?: string) =>
      request<void>(
        `/api/git/repositories/${encodeURIComponent(workspaceId)}/pull`,
        {},
        key ? { 'idempotency-key': key } : {},
      ),
    checkoutGitBranch: (workspaceId: string, branch: string) =>
      request<void>(`/api/git/repositories/${encodeURIComponent(workspaceId)}/checkout`, {
        branch,
      }),
    pushGit: (workspaceId: string, key?: string) =>
      request<void>(
        `/api/git/repositories/${encodeURIComponent(workspaceId)}/push`,
        {},
        key ? { 'idempotency-key': key } : {},
      ),
    listAvailableSkills: (workspaceId: string, profile: string, refresh = false) =>
      get<RelaySkillList>(
        `/api/skills?${new URLSearchParams({
          workspaceId,
          profile,
          ...(refresh ? { refresh: 'true' } : {}),
        }).toString()}`,
      ),
    listSkillProfiles: () => get<RelaySkillProfileList>('/api/skill-profiles'),
    replaceSkillProfile: (
      name: string,
      profile: Pick<RelaySkillProfile, 'version' | 'name' | 'skills'>,
    ) =>
      put<RelaySkillProfile>(
        `/api/skill-profiles/${encodeURIComponent(name)}`,
        profile,
      ),
    deleteSkillProfile: (name: string) =>
      remove(`/api/skill-profiles/${encodeURIComponent(name)}`),
    respondInteraction: (sessionId: string, requestId: string, value: unknown) =>
      request<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(requestId)}`,
        value,
      ),
  };
}
