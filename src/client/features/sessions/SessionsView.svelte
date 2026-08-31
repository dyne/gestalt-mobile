<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import AppControl from '../../components/AppControl.svelte';
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import FilesystemTree from '../filesystem-tree/FilesystemTree.svelte';
  import { findTreeNode, treeNodePolicies } from '../filesystem-tree/tree-state.js';
  import type {
    RecentSession,
    RelaySession,
    RelaySkillProfile,
    StartSessionSettings,
  } from './relay-client.js';
  import { formatRelativeTime } from './relative-time.js';
  import { displayWorkspacePath, managedSessionDetails } from './session-list.js';
  import AgentActivityIndicators from '../agent-activity/AgentActivityIndicators.svelte';
  import type { AgentActivitySnapshot } from '../agent-activity/contracts.js';
  import AutopilotControl from '../autopilot/AutopilotControl.svelte';
  import AutopilotLiveness from '../autopilot/AutopilotLiveness.svelte';
  import type { AutopilotSnapshot } from '../autopilot/contracts.js';
  import type { OrgPlanAttention } from '../autopilot/contracts.js';
  import AutopilotAttention from '../autopilot/AutopilotAttention.svelte';
  import AutopilotSafetyStop from '../autopilot/AutopilotSafetyStop.svelte';
  import PlanProgress from '../plans/PlanProgress.svelte';

  type Props = {
    sessions: RelaySession[];
    recentSessions: RecentSession[];
    selectedSessionId: string | null;
    activitySnapshots?: ReadonlyMap<string, AgentActivitySnapshot>;
    autopilotSnapshots?: ReadonlyMap<string, AutopilotSnapshot>;
    autopilotPending?: ReadonlySet<string>;
    autopilotAttention?: ReadonlyMap<string, OrgPlanAttention>;
    workspaceTree: WorkspaceOption[];
    workspaceId: string;
    expandedIds: ReadonlySet<string>;
    sandbox: NonNullable<StartSessionSettings['sandbox']>;
    approvalPolicy: NonNullable<StartSessionSettings['approvalPolicy']>;
    models?: string[];
    selectedModel?: string;
    skillProfiles: RelaySkillProfile[];
    selectedSkillProfile: string;
    skillProfileError: string;
    startingSession: boolean;
    openingSessionId: string | null;
    onworkspacechange: (value: string) => void;
    onexpandedchange: (value: Set<string>) => void;
    onsandboxchange: (value: NonNullable<StartSessionSettings['sandbox']>) => void;
    onapprovalpolicychange: (value: NonNullable<StartSessionSettings['approvalPolicy']>) => void;
    onmodelchange?: (value: string) => void;
    onskillprofilechange: (value: string) => void;
    onmanageprofiles: (trigger: HTMLButtonElement) => void;
    onopen: (id: string) => void;
    onselectopen: (id: string) => void;
    onclose: (id: string) => void;
    onautopilottoggle?: (id: string, enabled: boolean) => void;
    onautopilotresolve?: (
      id: string,
      action: 'resume' | 'disableAutopilot',
      guidance?: string,
    ) => void;
    onopenrecent: (session: RecentSession) => void;
    onforget: (id: string) => void;
    oncopyresume: (command: string) => void;
    onstart: () => void;
  };

  let {
    sessions,
    recentSessions,
    selectedSessionId,
    activitySnapshots = new Map(),
    autopilotSnapshots = new Map(),
    autopilotPending = new Set(),
    autopilotAttention = new Map(),
    workspaceTree,
    workspaceId,
    expandedIds,
    sandbox,
    approvalPolicy,
    models = [],
    selectedModel = '',
    skillProfiles,
    selectedSkillProfile,
    skillProfileError,
    startingSession,
    openingSessionId,
    onworkspacechange,
    onexpandedchange,
    onsandboxchange,
    onapprovalpolicychange,
    onmodelchange = () => {},
    onskillprofilechange,
    onmanageprofiles,
    onopen,
    onselectopen,
    onclose,
    onautopilottoggle = () => {},
    onautopilotresolve = () => {},
    onopenrecent,
    onforget,
    oncopyresume,
    onstart,
  }: Props = $props();

  let openSessions = $derived(
    sessions.filter((session) => session.state === 'ready' || session.state === 'turnActive'),
  );
  let savedSessions = $derived(
    sessions.filter((session) => session.state !== 'ready' && session.state !== 'turnActive'),
  );
  let otherRecentSessions = $derived(
    recentSessions.filter(
      (recent) => !openSessions.some((session) => session.threadId === recent.id),
    ),
  );
  let selectedWorkspace = $derived(findTreeNode(workspaceTree, workspaceId));
</script>

<section aria-labelledby="sessions-title">
  <h2 id="sessions-title" class="visually-hidden">Sessions</h2>
  {#if openSessions.length}
    <section aria-labelledby="open-sessions-title">
      <h3 id="open-sessions-title">Open sessions</h3>
      <ul class="session-list" aria-label="Open sessions">
        {#each openSessions as session (session.id)}
          {@const details = managedSessionDetails(session)}
          <li
            class:current-session={session.id === selectedSessionId}
            class="managed-session open-session"
          >
            <div class="session-actions" aria-label="Session actions">
              <AppControl
                compact
                full
                current={session.id === selectedSessionId ? 'page' : undefined}
                onclick={() => onselectopen(session.id)}>Open</AppControl
              >
              {#if session.resumeCommand}
                <AppControl compact full onclick={() => oncopyresume(session.resumeCommand!)}
                  >Copy</AppControl
                >
              {/if}
              <AutopilotControl
                compact
                indicatorOnly
                autopilot={autopilotSnapshots.get(session.id) ?? session.autopilot ?? null}
                controlId={`session-autopilot-${session.id}`}
                pending={autopilotPending.has(session.id)}
                ontoggle={(enabled) => onautopilottoggle(session.id, enabled)}
              />
              <AgentActivityIndicators
                compact
                activity={activitySnapshots.get(session.id) ?? session.agentActivity ?? null}
                popupAlign="start"
                rootModel={session.model ?? models?.[0]}
              />
              <AppControl compact full onclick={() => onclose(session.id)}>Close</AppControl>
              <AutopilotLiveness
                autopilot={autopilotSnapshots.get(session.id) ?? session.autopilot ?? null}
                connected={(activitySnapshots.get(session.id) ?? session.agentActivity)?.root
                  .state !== 'disconnected'}
              />
            </div>
            <div class="session-details">
              <div class="session-summary">
                {#if details.updatedAt !== null}
                  <time datetime={new Date(details.updatedAt).toISOString()}>
                    {formatRelativeTime(details.updatedAt)}
                  </time>
                {:else}
                  <div>{formatRelativeTime(null)}</div>
                {/if}
                <div class="workspace-path">{displayWorkspacePath(details.workspacePath)}</div>
                {#if session.model}
                  <span class="profile-badge">Model: {session.model}</span>
                {/if}
                {#if session.branch}<span class="profile-badge">Branch: {session.branch}</span>{/if}
                {#if session.effectiveSkillSelection?.selectedProfileName}
                  <span class="profile-badge"
                    >Skills profile: {session.effectiveSkillSelection.selectedProfileName}</span
                  >
                {/if}
                {#if session.lastOrgPlan}
                  <span class="org-plan-metadata">
                    <span class="org-plan-title">{session.lastOrgPlan.title}</span>
                    <span class="org-plan-filename">{session.lastOrgPlan.filename}</span>
                  </span>
                {/if}
                {#if session.plan}
                  <div class="session-plan-progress">
                    <PlanProgress
                      compact
                      plan={session.plan}
                      label={`Plan progress for ${session.plan.title}`}
                    />
                  </div>
                {/if}
              </div>
              <AutopilotAttention
                attention={autopilotAttention.get(session.id) ?? null}
                controlId={`session-attention-${session.id}`}
                pending={autopilotPending.has(session.id)}
                onresolve={(action, guidance) => onautopilotresolve(session.id, action, guidance)}
              />
              <AutopilotSafetyStop
                autopilot={autopilotSnapshots.get(session.id) ?? session.autopilot ?? null}
                attention={autopilotAttention.get(session.id) ?? null}
                controlId={`session-autopilot-safety-${session.id}`}
                pending={autopilotPending.has(session.id)}
                onrecover={() => onautopilottoggle(session.id, true)}
                ondisable={() => onautopilottoggle(session.id, false)}
              />
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if savedSessions.length}
    <ul class="session-list" aria-label="Saved sessions">
      {#each savedSessions as session (session.id)}
        {@const details = managedSessionDetails(session)}
        <li class="managed-session">
          <div class="session-actions">
            <AppControl
              compact
              full
              disabled={openingSessionId === session.id}
              onclick={() => onopen(session.id)}
            >
              {openingSessionId === session.id ? 'Opening…' : 'Open'}
            </AppControl>
            {#if session.resumeCommand}
              <AppControl compact full onclick={() => oncopyresume(session.resumeCommand!)}
                >Copy</AppControl
              >
            {/if}
            <AppControl compact full onclick={() => onforget(session.id)}>Forget</AppControl>
          </div>
          <div class="session-details">
            {#if details.updatedAt !== null}
              <time datetime={new Date(details.updatedAt).toISOString()}>
                {formatRelativeTime(details.updatedAt)}
              </time>
            {:else}
              <div>{formatRelativeTime(null)}</div>
            {/if}
            <div class="workspace-path">{displayWorkspacePath(details.workspacePath)}</div>
            {#if session.model}
              <span class="profile-badge">Model: {session.model}</span>
            {/if}
            {#if session.branch}<span class="profile-badge">Branch: {session.branch}</span>{/if}
            {#if session.effectiveSkillSelection?.selectedProfileName}
              <span class="profile-badge"
                >Skills profile: {session.effectiveSkillSelection.selectedProfileName}</span
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {:else if !openSessions.length}
    <p>No saved sessions yet.</p>
  {/if}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      onstart();
    }}
  >
    <section class="session-base" aria-labelledby="session-base-title">
      <div class="session-base-heading">
        <h3 id="session-base-title">Session base</h3>
        <p>Select the folder or repository Codex should use as its working directory.</p>
      </div>
      <FilesystemTree
        roots={workspaceTree}
        {expandedIds}
        selectedId={selectedWorkspace?.id ?? null}
        isSelectable={treeNodePolicies.sessionBase}
        label="Session base"
        {onexpandedchange}
        onselect={(node) => onworkspacechange(node.id)}
      />
    </section>
    <section class="session-settings" aria-label="New session settings">
      <div class="session-setting-labels">
        <label for="skills-profile">Skills profile</label>
        <label for="sandbox">Sandbox</label>
        <label for="approval-policy">Approval policy</label>
      </div>
      <div class="session-setting-controls">
        <select
          id="skills-profile"
          value={selectedSkillProfile}
          onchange={(event) => onskillprofilechange(event.currentTarget.value)}
        >
          <option value="">Default</option>
          {#each skillProfiles as profile (profile.name)}
            <option value={profile.name}>{profile.name}</option>
          {/each}
        </select>
        <select
          id="sandbox"
          value={sandbox}
          onchange={(event) =>
            onsandboxchange(
              event.currentTarget.value as NonNullable<StartSessionSettings['sandbox']>,
            )}
        >
          <option value="workspace-write">workspace-write</option>
          <option value="read-only">read-only</option>
          <option value="danger-full-access">danger-full-access</option>
        </select>
        <select
          id="approval-policy"
          value={approvalPolicy}
          aria-describedby="approval-policy-help"
          onchange={(event) =>
            onapprovalpolicychange(
              event.currentTarget.value as NonNullable<StartSessionSettings['approvalPolicy']>,
            )}
        >
          <option value="untrusted">Ask on all commands</option>
          <option value="on-request">Ask out of workspace</option>
          <option value="never">Approve everything</option>
        </select>
      </div>
      <p id="approval-policy-help">
        This controls when Codex asks; it does not expand the sandbox's technical permissions.
      </p>
      {#if skillProfileError}<p class="skills-profile-error" role="alert">
          {skillProfileError}
        </p>{/if}
      <div class="session-secondary-actions">
        <AppControl
          id="manage-skill-profiles"
          onclick={(event) => onmanageprofiles(event.currentTarget)}
          >Manage skill profiles
        </AppControl>
        <div class="model-control">
          <label for="model">Model</label>
          <select
            id="model"
            value={selectedModel}
            disabled={models.length === 0}
            onchange={(event) => onmodelchange(event.currentTarget.value)}
          >
            {#each models as model (model)}
              <option value={model}>{model}</option>
            {/each}
          </select>
        </div>
        <AppControl
          class="new-session-button"
          type="submit"
          primary
          disabled={!selectedWorkspace || startingSession}
        >
          {startingSession ? 'Creating…' : 'Create session'}
        </AppControl>
      </div>
    </section>
  </form>
  <section aria-labelledby="recent-sessions-title">
    <h3 id="recent-sessions-title">Recent sessions</h3>
    {#if otherRecentSessions.length}
      <ul class="session-list recent-session-list" aria-label="Recent sessions">
        {#each otherRecentSessions as session (session.id)}
          <li class="recent-session">
            <div class="session-details">
              {#if session.recencyAt !== null}
                <time datetime={new Date(session.recencyAt * 1000).toISOString()}
                  >{formatRelativeTime(session.recencyAt * 1000)}</time
                >
              {:else}
                <div>{formatRelativeTime(null)}</div>
              {/if}
              <div class="workspace-path">{displayWorkspacePath(session.cwd)}</div>
              {#if session.model}<span class="profile-badge">Model: {session.model}</span>{/if}
              {#if session.skillProfile}<span class="profile-badge"
                  >Skills profile: {session.skillProfile}</span
                >{/if}
              {#if session.orgPlanFilename}<span class="profile-badge"
                  >Org plan: {session.orgPlanFilename}</span
                >{/if}
            </div>
            <div class="session-actions">
              <AppControl onclick={() => onopenrecent(session)}>Open</AppControl>
              <AppControl onclick={() => oncopyresume(session.resumeCommand)}>Copy</AppControl>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p>No other recent Codex sessions found.</p>
    {/if}
  </section>
</section>

<style>
  .session-list {
    display: grid;
    gap: 1rem;
    margin-block: 0 1.5rem;
    padding-inline: 0;
    inline-size: 100%;
    list-style: none;
  }

  .current-session {
    outline: 2px solid var(--theme-accent);
    outline-offset: 2px;
  }
  .managed-session {
    display: grid;
    grid-template-columns: minmax(0, min(6rem, 32%)) minmax(0, 1fr);
    gap: 0.75rem;
    align-items: start;
    inline-size: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    border: 1px solid var(--theme-border);
    border-radius: 0.5rem;
  }

  .open-session {
    border-color: var(--theme-accent);
    background: var(--theme-control-hover);
  }

  .session-details {
    min-inline-size: 0;
  }

  .workspace-path {
    overflow-wrap: anywhere;
  }

  .profile-badge {
    display: inline-block;
    margin-block-start: 0.35rem;
    padding: 0.15rem 0.4rem;
    border-radius: 999px;
    background: var(--theme-control-pressed);
    color: var(--theme-control-pressed-contrast);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }

  .org-plan-metadata {
    display: grid;
    gap: 0.125rem;
    margin-block-start: 0.35rem;
  }
  .org-plan-title {
    font-weight: 600;
  }
  .org-plan-filename {
    overflow-wrap: anywhere;
    color: var(--theme-text-muted);
  }

  .session-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-inline-size: 0;
  }

  .session-actions > :global(*) {
    inline-size: 100%;
  }

  .session-plan-progress {
    min-inline-size: 0;
    margin-block-start: 0.5rem;
  }

  .recent-session {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    gap: 0.75rem;
    align-items: start;
  }

  .session-base {
    display: grid;
    gap: 0.65rem;
    min-inline-size: 0;
    margin-block: 1rem;
  }

  .session-base-heading h3,
  .session-base-heading p {
    margin: 0;
  }

  .session-base-heading p {
    margin-block-start: 0.25rem;
  }

  .session-settings {
    display: grid;
    gap: 0.5rem;
    min-inline-size: 0;
    margin-block-end: 0.75rem;
  }

  .session-setting-labels,
  .session-setting-controls {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    min-inline-size: 0;
  }

  .session-setting-labels label {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .session-setting-controls select {
    inline-size: 100%;
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .session-secondary-actions,
  .model-control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-inline-size: 0;
  }

  .session-secondary-actions {
    flex-wrap: wrap;
  }

  .model-control {
    margin-inline-start: auto;
  }

  .skills-profile-error {
    margin: 0;
    font-size: 0.875rem;
  }

  .skills-profile-error {
    color: var(--theme-error);
  }

  @media (max-width: 28rem) {
    .model-control {
      margin-inline-start: 0;
    }
  }
</style>
