/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from '../plans/contracts.js';
import type {
  ChatSnapshot,
  SafeInteractionOutcome,
} from '../../../shared/contracts/chat-snapshot.js';
import type { AgentActivitySnapshot } from '../agent-activity/contracts.js';
import type { AutopilotSnapshot } from '../autopilot/contracts.js';

export type WorkspacePlanEntry = Readonly<{
  planName: string;
  title: string;
  subtitle?: string;
  date?: string;
  keywords?: string;
  previewAvailable: boolean;
  totalSteps?: number;
  doneSteps?: number;
  allDone?: boolean;
}>;

export type WorkspaceOrgPreview = Readonly<{
  kind: 'org-source';
  planName: string;
  title: string;
  source: string;
}>;

export type RelayWorkspaceFile = Readonly<{
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
  modifiedAt?: string;
}>;
export type RelayWorkspaceDirectory = Readonly<{
  directory: string;
  entries: readonly RelayWorkspaceFile[];
  nextCursor?: string;
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
  plan?: SupervisedPlan;
  agentActivity?: AgentActivitySnapshot;
  autopilot?: AutopilotSnapshot;
};
export type RestoreSessionResult = RelaySession & {
  recovery?: { historyUnavailable: true; replacementCreated: true };
};
export type RelayInteractionResponse = {
  accepted: true;
  resolvedAt: string;
  outcome: SafeInteractionOutcome;
};
export type RelayRequestError = Error & {
  code?: string;
  status?: number;
  replaceAllowed?: boolean;
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
export type RelayHistory = Partial<Omit<ChatSnapshot, 'items'>> & {
  items: RelayHistoryItem[];
  /** Lower-bound sequence captured before the history read. */
  baseSequence?: number;
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
  dependencies?: {
    tools?: Array<{
      type: string;
      value: string;
      description?: string;
      transport?: string;
      command?: string;
      url?: string;
    }>;
  };
  path: string;
  scope?: string;
  nativeEnabled: boolean;
  effectiveEnabled: boolean;
  alwaysAdvertised: boolean;
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
  async function failure(response: Response): Promise<RelayRequestError> {
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      detail?: unknown;
      title?: unknown;
      replaceAllowed?: unknown;
    } | null;
    const safeCode =
      typeof body?.code === 'string' && /^[A-Z0-9_]+$/.test(body.code) ? body.code : undefined;
    const message =
      safeCode?.startsWith('AUTOPILOT_') && response.status === 409
        ? `Relay request failed (${response.status}).`
        : typeof body?.detail === 'string' && body.detail.length <= 600
          ? body.detail
          : typeof body?.title === 'string'
            ? body.title
            : `Relay request failed (${response.status}).`;
    return Object.assign(new Error(message), {
      ...(safeCode ? { code: safeCode } : {}),
      ...(typeof body?.replaceAllowed === 'boolean' ? { replaceAllowed: body.replaceAllowed } : {}),
      status: response.status,
    });
  }
  async function request<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }
  async function put<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetcher(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }
  async function upload<T>(
    path: string,
    body: Blob,
    key: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetcher(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'idempotency-key': key },
      body,
      signal,
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<T>;
  }
  async function deleteJson<T>(path: string, body: unknown, key: string): Promise<T> {
    const response = await fetcher(path, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
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
    listSessions: (signal?: AbortSignal) => get<RelaySession[]>('/api/sessions', signal),
    listWorkspaceDirectory: (
      workspaceId: string,
      input: { directory?: string; cursor?: string; limit?: number } = {},
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (input.directory !== undefined) query.set('directory', input.directory);
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size === 0 ? '' : `?${query}`;
      return get<RelayWorkspaceDirectory>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files${suffix}`,
        signal,
      );
    },
    copyWorkspaceEntry: (
      workspaceId: string,
      input: {
        source: string;
        destinationDirectory: string;
        conflict: 'reject' | 'replace' | 'keep-both';
      },
      key: string,
    ) =>
      request<{ path: string; kind: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/copy`,
        input,
        { 'idempotency-key': key },
      ),
    moveWorkspaceEntry: (
      workspaceId: string,
      input: {
        source: string;
        destinationDirectory: string;
        conflict: 'reject' | 'replace' | 'keep-both';
      },
      key: string,
    ) =>
      request<{ path: string; kind: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/move`,
        input,
        { 'idempotency-key': key },
      ),
    uploadWorkspaceFile: (
      workspaceId: string,
      input: {
        directory: string;
        filename: string;
        conflict: 'reject' | 'replace' | 'keep-both';
        file: Blob;
      },
      key: string,
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams({
        directory: input.directory,
        filename: input.filename,
        conflict: input.conflict,
      });
      return upload<{ path: string; kind: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/upload?${query}`,
        input.file,
        key,
        signal,
      );
    },
    deleteWorkspaceEntry: (workspaceId: string, path: string, key: string) =>
      deleteJson<{ path: string; kind: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files`,
        { path, recursive: true },
        key,
      ),
    getSession: (sessionId: string) =>
      get<RelaySession>(`/api/sessions/${encodeURIComponent(sessionId)}`),
    refreshActivity: (sessionId: string) =>
      request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/activity/refresh`, {}),
    setAutopilot: (sessionId: string, enabled: boolean, key?: string) =>
      put<{ autopilot: AutopilotSnapshot }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/autopilot`,
        { enabled },
        key ? { 'idempotency-key': key } : {},
      ),
    resolveAttention: (
      sessionId: string,
      requestId: string,
      input: { operationKey: string; action: 'resume' | 'disableAutopilot'; guidance?: string },
    ) =>
      request<unknown>(
        `/api/sessions/${encodeURIComponent(sessionId)}/attention/${encodeURIComponent(requestId)}/resolve`,
        input,
      ),
    listRecentSessions: () => get<RecentSession[]>('/api/sessions/recent-threads'),
    openRecentSession: (threadId: string, cwd: string) =>
      request<RelaySession>('/api/sessions/recent-threads/open', { threadId, cwd }),
    startSession: (workspaceId: string, settings: StartSessionSettings = {}, key?: string) =>
      request<RelaySession>(
        '/api/sessions',
        { workspaceId, profile: 'default', ...settings },
        key ? { 'idempotency-key': key } : {},
      ),
    startTurn: (sessionId: string, text: string, key?: string) =>
      request<{ activeTurnId?: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          text,
        },
        key ? { 'idempotency-key': key } : {},
      ),
    selectModel: (sessionId: string, model: string) =>
      request<RelaySession>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, { model }),
    interruptTurn: (sessionId: string, turnId: string) =>
      request<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
        {},
      ),
    queueTurnInput: (sessionId: string, turnId: string, text: string, key?: string) =>
      request<{ activeTurnId: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/queue`,
        { text },
        key ? { 'idempotency-key': key } : {},
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
    closePlan: (sessionId: string) => remove(`/api/sessions/${encodeURIComponent(sessionId)}/plan`),
    listWorkspacePlans: (workspaceId: string, signal?: AbortSignal) =>
      get<WorkspacePlanEntry[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/plans`, signal),
    getWorkspacePlan: (workspaceId: string, planName: string, signal?: AbortSignal) =>
      get<SupervisedPlan | WorkspaceOrgPreview>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planName)}`,
        signal,
      ),
    openSessionPlan: (sessionId: string, planName: string) =>
      put<SupervisedPlan | WorkspaceOrgPreview>(
        `/api/sessions/${encodeURIComponent(sessionId)}/plan`,
        { planName },
      ),
    getGitSummary: (workspaceId: string, signal?: AbortSignal) =>
      get<RelayGitSummary>(`/api/git/repositories/${encodeURIComponent(workspaceId)}`, signal),
    cloneGitRepository: (workspaceId: string, address: string) =>
      request<void>('/api/git/clone', { workspaceId, address }),
    refreshGit: (workspaceId: string, key?: string) =>
      request<void>(
        `/api/git/repositories/${encodeURIComponent(workspaceId)}/refresh`,
        {},
        key ? { 'idempotency-key': key } : {},
      ),
    pullGit: (workspaceId: string, key?: string, signal?: AbortSignal) =>
      request<void>(
        `/api/git/repositories/${encodeURIComponent(workspaceId)}/pull`,
        {},
        key ? { 'idempotency-key': key } : {},
        signal,
      ),
    checkoutGitBranch: (workspaceId: string, branch: string, signal?: AbortSignal) =>
      request<void>(
        `/api/git/repositories/${encodeURIComponent(workspaceId)}/checkout`,
        {
          branch,
        },
        {},
        signal,
      ),
    pushGit: (workspaceId: string, key?: string) =>
      request<void>(
        `/api/git/repositories/${encodeURIComponent(workspaceId)}/push`,
        {},
        key ? { 'idempotency-key': key } : {},
      ),
    listAvailableSkills: (
      workspaceId: string,
      profile: string,
      refresh = false,
      signal?: AbortSignal,
    ) =>
      get<RelaySkillList>(
        `/api/skills?${new URLSearchParams({
          workspaceId,
          profile,
          ...(refresh ? { refresh: 'true' } : {}),
        }).toString()}`,
        signal,
      ),
    listSkillProfiles: (signal?: AbortSignal) =>
      get<RelaySkillProfileList>('/api/skill-profiles', signal),
    replaceSkillProfile: (
      name: string,
      profile: Pick<RelaySkillProfile, 'version' | 'name' | 'skills'>,
    ) => put<RelaySkillProfile>(`/api/skill-profiles/${encodeURIComponent(name)}`, profile),
    deleteSkillProfile: (name: string) => remove(`/api/skill-profiles/${encodeURIComponent(name)}`),
    respondInteraction: (sessionId: string, requestId: string, value: unknown, key?: string) =>
      request<RelayInteractionResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(requestId)}`,
        value,
        key ? { 'idempotency-key': key } : {},
      ),
  };
}
