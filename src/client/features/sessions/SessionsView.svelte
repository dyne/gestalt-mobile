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
  import type { LlmProvider } from '../../../shared/contracts/llm-provider.js';
  import { formatRelativeTime } from './relative-time.js';
  import { displayWorkspacePath, managedSessionDetails } from './session-list.js';
  import AgentActivityIndicators from '../agent-activity/AgentActivityIndicators.svelte';
  import type { AgentActivitySnapshot } from '../agent-activity/contracts.js';
  import AutopilotControl from '../autopilot/AutopilotControl.svelte';
  import type { AutopilotSnapshot } from '../autopilot/contracts.js';
  import type { OrgPlanAttention } from '../autopilot/contracts.js';
  import AutopilotAttention from '../autopilot/AutopilotAttention.svelte';
  import AutopilotSafetyStop from '../autopilot/AutopilotSafetyStop.svelte';
  import PlanProgress from '../plans/PlanProgress.svelte';
  import { isSessionStatus } from './session-status.js';
  import {
    thinkingLevels,
    type ThinkingLevel,
  } from '../../../shared/contracts/session-model-settings.js';

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
    reasoningEffort?: ThinkingLevel;
    executorModels?: string[];
    executorModel?: string;
    executorReasoningEffort?: ThinkingLevel;
    onreasoningchange?: (value: ThinkingLevel) => void;
    onexecutormodelchange?: (value: string) => void;
    onexecutorreasoningchange?: (value: ThinkingLevel) => void;
    /** Provider chosen for the new session; defaults to codex. */
    provider?: LlmProvider;
    /** Whether the kimi CLI is installed; enables the Kimi provider option when true. */
    kimiAvailable?: boolean;
    modelsLoading?: boolean;
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
    onproviderchange?: (value: LlmProvider) => void;
    onskillprofilechange: (value: string) => void;
    onmanageprofiles: (trigger: HTMLButtonElement) => void;
    onopen: (id: string) => void;
    onselectopen: (id: string) => void;
    onclose: (id: string) => void;
    onautopilottoggle?: (id: string, enabled: boolean) => void;
    onactivityopen?: (id: string) => void;
    onautopilotresolve?: (
      id: string,
      action: 'resume' | 'disableAutopilot',
      guidance?: string,
    ) => void;
    onopenrecent: (session: RecentSession) => void;
    onforget: (id: string) => void;
    oncopyresume: (command: string) => void;
    onstart: () => void;
    savingDefaults?: boolean;
    advancedExpanded?: boolean;
    onsavedefaults?: () => void;
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
    reasoningEffort = 'medium',
    executorModels = [],
    executorModel = 'gpt-5.6-terra',
    executorReasoningEffort = 'high',
    onreasoningchange = () => {},
    onexecutormodelchange = () => {},
    onexecutorreasoningchange = () => {},
    provider = 'codex',
    kimiAvailable = false,
    modelsLoading = false,
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
    onproviderchange = () => {},
    onskillprofilechange,
    onmanageprofiles,
    onopen,
    onselectopen,
    onclose,
    onautopilottoggle = () => {},
    onactivityopen = () => {},
    onautopilotresolve = () => {},
    onopenrecent,
    onforget,
    oncopyresume,
    onstart,
    savingDefaults = false,
    advancedExpanded = $bindable(false),
    onsavedefaults = () => {},
  }: Props = $props();

  let openSessions = $derived(
    sessions.filter((session) => session.state === 'ready' || session.state === 'turnActive'),
  );
  let savedSessions = $derived(
    sessions.filter((session) => session.state !== 'ready' && session.state !== 'turnActive'),
  );
  let otherRecentSessions = $derived(
    recentSessions.filter(
      (recent) =>
        !openSessions.some(
          (session) =>
            session.threadId === recent.id &&
            (session.provider ?? 'codex') === (recent.provider ?? 'codex'),
        ),
    ),
  );
  let selectedWorkspace = $derived(findTreeNode(workspaceTree, workspaceId));
  let closeDialog = $state<HTMLDialogElement | null>(null);
  let closingSessionId = $state<string | null>(null);
  function requestClose(id: string) {
    closingSessionId = id;
    closeDialog?.showModal();
  }
</script>

{#snippet sessionPlanContext(session: RelaySession)}
  {#if session.plan || session.lastOrgPlan?.attached}
    <span class="profile-badge">Org plan attached</span>
  {/if}
  {#if session.lastOrgPlan}
    <span class="org-plan-metadata">
      <span class="org-plan-title">{session.lastOrgPlan.title}</span>
      <span class="org-plan-filename">{session.lastOrgPlan.filename}</span>
    </span>
  {/if}
  {#if session.plan}
    <div class="session-plan-progress">
      <PlanProgress compact plan={session.plan} label={`Plan progress for ${session.plan.title}`} />
    </div>
  {/if}
{/snippet}

<dialog
  bind:this={closeDialog}
  aria-labelledby="close-session-title"
  onclose={() => (closingSessionId = null)}
>
  <h2 id="close-session-title">Close session?</h2>
  <p>You can reopen this session from the session list.</p>
  <div class="dialog-actions">
    <AppControl onclick={() => closeDialog?.close()}>Cancel</AppControl>
    <AppControl
      primary
      onclick={() => {
        if (closingSessionId) onclose(closingSessionId);
        closeDialog?.close();
      }}>Close session</AppControl
    >
  </div>
</dialog>

<section aria-labelledby="sessions-title">
  <h2 id="sessions-title" class="visually-hidden">Sessions</h2>
  {#if openSessions.length}
    <section aria-labelledby="open-sessions-title">
      <h3 id="open-sessions-title">Open sessions</h3>
      <ul class="session-list" aria-label="Open sessions">
        {#each openSessions as session (session.id)}
          {@const details = managedSessionDetails(session)}
          {@const sessionStatus = isSessionStatus(session.sessionStatus)
            ? session.sessionStatus
            : null}
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
              {#if session.resumeCommand && session.provider !== 'kimi'}
                <AppControl compact full onclick={() => oncopyresume(session.resumeCommand!)}
                  >Copy CLI</AppControl
                >
              {/if}
              {#if session.provider !== 'kimi'}
                <AutopilotControl
                  compact
                  indicatorOnly
                  autopilot={autopilotSnapshots.get(session.id) ?? session.autopilot ?? null}
                  controlId={`session-autopilot-${session.id}`}
                  pending={autopilotPending.has(session.id)}
                  ontoggle={(enabled) => onautopilottoggle(session.id, enabled)}
                />
              {/if}
              <AgentActivityIndicators
                compact
                activity={activitySnapshots.get(session.id) ?? session.agentActivity ?? null}
                rootModel={session.model ?? models?.[0]}
                plan={session.plan}
                onopen={() => onactivityopen(session.id)}
              />
              <AppControl compact full onclick={() => requestClose(session.id)}>Close</AppControl>
            </div>
            <div class="session-details">
              <div class="session-summary">
                {#if sessionStatus}
                  <details
                    class="session-verdict"
                    data-state={sessionStatus.state}
                    aria-label={`${sessionStatus.state === 'working' ? 'Working' : 'Idle'}: ${sessionStatus.reason}`}
                  >
                    <summary
                      aria-label={`${sessionStatus.state === 'working' ? 'Working' : 'Idle'}: ${sessionStatus.reason}`}
                    >
                      <span
                        class:live={sessionStatus.state === 'working' &&
                          sessionStatus.confidence === 'fresh'}
                        class="verdict-dot"
                        aria-hidden="true"
                      ></span>
                      {sessionStatus.state === 'working' ? 'Working' : 'Idle'}
                    </summary>
                    <p>
                      {sessionStatus.reason}. {sessionStatus.nextExpectedAction}
                      Evidence confidence: {sessionStatus.confidence}.
                    </p>
                  </details>
                {/if}
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
                {#if session.provider === 'kimi'}<span class="profile-badge">Kimi</span>{/if}
                {#if session.branch}<span class="profile-badge">Branch: {session.branch}</span>{/if}
                {#if session.effectiveSkillSelection?.selectedProfileName}
                  <span class="profile-badge"
                    >Skills profile: {session.effectiveSkillSelection.selectedProfileName}</span
                  >
                {/if}
                {@render sessionPlanContext(session)}
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
            {#if session.resumeCommand && session.provider !== 'kimi'}
              <AppControl compact full onclick={() => oncopyresume(session.resumeCommand!)}
                >Copy CLI</AppControl
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
            {#if session.provider === 'kimi'}<span class="profile-badge">Kimi</span>{/if}
            {#if session.branch}<span class="profile-badge">Branch: {session.branch}</span>{/if}
            {#if session.effectiveSkillSelection?.selectedProfileName}
              <span class="profile-badge"
                >Skills profile: {session.effectiveSkillSelection.selectedProfileName}</span
              >
            {/if}
            {@render sessionPlanContext(session)}
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
    <h3 class="new-session-title">New session</h3>
    <div class="session-base">
      <FilesystemTree
        roots={workspaceTree}
        {expandedIds}
        selectedId={selectedWorkspace?.id ?? null}
        isSelectable={treeNodePolicies.sessionBase}
        label="Session base"
        {onexpandedchange}
        onselect={(node) => onworkspacechange(node.id)}
      />
    </div>
    <div class="essential-settings">
      <label for="skills-profile"
        >Skills profile
        <select
          id="skills-profile"
          value={selectedSkillProfile}
          onchange={(event) => onskillprofilechange(event.currentTarget.value)}
        >
          <option value="">Default</option>
          {#each skillProfiles as profile (profile.name)}<option value={profile.name}
              >{profile.name}</option
            >{/each}
        </select>
      </label>
      <label for="model"
        >Model
        <select
          id="model"
          value={selectedModel}
          disabled={modelsLoading || models.length === 0}
          onchange={(event) => onmodelchange(event.currentTarget.value)}
        >
          {#if modelsLoading}<option value="">Loading models…</option>
          {:else if models.length === 0}<option value="">Choose automatically</option>{/if}
          {#each models as model (model)}<option value={model}>{model}</option>{/each}
        </select>
      </label>
    </div>
    {#if skillProfileError}<p class="skills-profile-error" role="alert">{skillProfileError}</p>{/if}
    <details class="advanced-settings" bind:open={advancedExpanded}>
      <summary>Advanced settings</summary>
      <div class="advanced-content">
        <section class="session-settings" aria-label="New session settings">
          <div class="advanced-model-settings">
            {#if provider === 'codex'}
              <fieldset class="executor-settings">
                <legend>Org-plan executor</legend>
                <label for="executor-model"
                  >Executor model
                  <select
                    id="executor-model"
                    value={executorModel}
                    onchange={(event) => onexecutormodelchange(event.currentTarget.value)}
                  >
                    {#each [...new Set([executorModel, ...executorModels])] as model (model)}<option
                        value={model}>{model}</option
                      >{/each}
                  </select>
                </label>
                <label for="executor-thinking"
                  >Executor thinking
                  <select
                    id="executor-thinking"
                    value={executorReasoningEffort}
                    onchange={(event) =>
                      onexecutorreasoningchange(event.currentTarget.value as ThinkingLevel)}
                  >
                    {#each thinkingLevels as level (level)}<option value={level}>{level}</option
                      >{/each}
                  </select>
                </label>
              </fieldset>
            {/if}
            <fieldset class="supervisor-settings">
              <legend>Main supervisor</legend>
              {#if provider === 'codex'}
                <label for="model-thinking"
                  >Model thinking
                  <select
                    id="model-thinking"
                    value={reasoningEffort}
                    onchange={(event) =>
                      onreasoningchange(event.currentTarget.value as ThinkingLevel)}
                  >
                    {#each thinkingLevels as level (level)}<option value={level}>{level}</option
                      >{/each}
                  </select>
                </label>
              {/if}
              <div class="provider-control">
                <label for="session-provider">Provider</label>
                <select
                  id="session-provider"
                  value={provider}
                  onchange={(event) => onproviderchange(event.currentTarget.value as LlmProvider)}
                >
                  <option value="codex">Codex</option>
                  <option value="kimi" disabled={!kimiAvailable}
                    >Kimi{kimiAvailable ? '' : ' (unavailable)'}</option
                  >
                </select>
              </div>
            </fieldset>
          </div>
          <div
            class="session-setting-labels"
            style:grid-template-columns={provider === 'kimi'
              ? 'minmax(0, 1fr)'
              : 'repeat(2, minmax(0, 1fr))'}
          >
            {#if provider !== 'kimi'}
              <label for="sandbox">Sandbox</label>
              <label for="approval-policy">Approval policy</label>
            {/if}
          </div>
          <div
            class="session-setting-controls"
            style:grid-template-columns={provider === 'kimi'
              ? 'minmax(0, 1fr)'
              : 'repeat(2, minmax(0, 1fr))'}
          >
            {#if provider !== 'kimi'}
              <select
                id="sandbox"
                value={sandbox}
                onchange={(event) =>
                  onsandboxchange(
                    event.currentTarget.value as NonNullable<StartSessionSettings['sandbox']>,
                  )}
              >
                <option value="workspace-git">workspace-git (Git writable)</option>
                <option value="workspace-write">workspace-write</option>
                <option value="read-only">read-only</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
              <select
                id="approval-policy"
                value={approvalPolicy}
                onchange={(event) =>
                  onapprovalpolicychange(
                    event.currentTarget.value as NonNullable<
                      StartSessionSettings['approvalPolicy']
                    >,
                  )}
              >
                <option value="untrusted">Ask on all commands</option>
                <option value="on-request">Ask out of workspace</option>
                <option value="never">Approve everything</option>
              </select>
            {/if}
          </div>
          <div class="session-secondary-actions">
            <AppControl
              class="manage-profiles-button"
              id="manage-skill-profiles"
              onclick={(event) => onmanageprofiles(event.currentTarget)}
              >Manage skill profiles
            </AppControl>
            <AppControl
              class="save-defaults-button"
              disabled={savingDefaults || modelsLoading || !selectedModel}
              onclick={onsavedefaults}
            >
              {savingDefaults ? 'Saving…' : 'Save as defaults'}
            </AppControl>
          </div>
        </section>
      </div>
    </details>
    <div class="create-session-actions">
      <AppControl
        class="new-session-button"
        type="submit"
        full
        primary
        disabled={!selectedWorkspace ||
          startingSession ||
          modelsLoading ||
          (models.length > 0 && !selectedModel)}
      >
        {startingSession ? 'Creating…' : 'Create session'}
      </AppControl>
    </div>
  </form>
  <section aria-labelledby="recent-sessions-title">
    <h3 id="recent-sessions-title">Recent sessions</h3>
    {#if otherRecentSessions.length}
      <ul class="session-list recent-session-list" aria-label="Recent sessions">
        {#each otherRecentSessions as session ((session.provider ?? 'codex') + ':' + session.id)}
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
              {#if session.provider === 'kimi'}<span class="profile-badge">Kimi</span>{/if}
              {#if session.skillProfile}<span class="profile-badge"
                  >Skills profile: {session.skillProfile}</span
                >{/if}
              {#if session.orgPlanFilename}<span class="profile-badge"
                  >Org plan: {session.orgPlanFilename}</span
                >{/if}
            </div>
            <div class="session-actions">
              <AppControl onclick={() => onopenrecent(session)}>Open</AppControl>
              {#if session.resumeCommand}
                <AppControl onclick={() => oncopyresume(session.resumeCommand!)}
                  >Copy to CLI</AppControl
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p>No other recent sessions found.</p>
    {/if}
  </section>
</section>

<style>
  .session-list {
    display: grid;
    gap: 0.65rem;
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
    grid-template-columns: minmax(0, 1fr) minmax(6rem, max-content);
    gap: 0.75rem;
    align-items: start;
    inline-size: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }

  .open-session {
    border-color: var(--theme-accent);
    background: var(--theme-control-hover);
  }

  .session-details {
    min-inline-size: 0;
  }

  .managed-session > .session-details {
    grid-column: 1;
    grid-row: 1;
  }
  .managed-session > .session-actions {
    grid-column: 2;
    grid-row: 1;
  }
  .session-summary,
  .recent-session .session-details,
  .managed-session:not(.open-session) .session-details {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.65rem;
  }
  .open-session .workspace-path,
  .session-plan-progress,
  .org-plan-metadata {
    flex-basis: 100%;
  }
  time {
    color: var(--theme-text-muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }

  .workspace-path {
    overflow-wrap: anywhere;
  }

  .profile-badge {
    display: inline-block;
    padding: 0.15rem 0.4rem;
    border-radius: 999px;
    background: var(--theme-control-pressed);
    color: var(--theme-control-pressed-contrast);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }

  .session-verdict {
    margin-block-end: 0.45rem;
    color: var(--theme-text-muted);
  }
  .session-verdict summary {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
    cursor: pointer;
    color: var(--theme-text);
    font-weight: 700;
  }
  .session-verdict p {
    max-inline-size: 65ch;
    margin: 0.35rem 0 0;
  }
  .verdict-dot {
    inline-size: 0.55rem;
    block-size: 0.55rem;
    border-radius: 50%;
    background: currentColor;
  }
  .verdict-dot.live {
    color: var(--theme-accent);
    animation: status-pulse 1.6s ease-out infinite;
  }
  @keyframes status-pulse {
    50% {
      opacity: 0.35;
      transform: scale(0.75);
    }
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
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    padding-block: 0.65rem;
    border-block-end: 1px solid var(--theme-border);
  }

  .recent-session .session-actions {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    max-inline-size: 100%;
    margin-inline-start: auto;
  }
  .recent-session .session-details {
    flex: 1 1 12rem;
    min-inline-size: 0;
  }
  .recent-session .session-actions > :global(*) {
    inline-size: auto;
  }
  form {
    margin-block: 1.75rem;
    padding-block: 1.25rem;
    border-block: 1px solid var(--theme-border);
  }
  .new-session-title {
    margin: 0 0 1rem;
  }
  .essential-settings {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .essential-settings label {
    display: grid;
    gap: 0.4rem;
    font-weight: 600;
  }
  select {
    min-inline-size: 0;
    inline-size: 100%;
    min-block-size: 44px;
  }
  .advanced-settings {
    margin-block: 1rem;
  }
  .advanced-settings > summary {
    min-block-size: 44px;
    align-content: center;
    cursor: pointer;
    color: var(--theme-text-muted);
    font-weight: 600;
  }
  .advanced-settings > summary:hover {
    color: var(--theme-text);
  }
  .advanced-content {
    padding-block: 0.25rem 0.75rem;
  }
  .create-session-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .create-session-actions :global(.new-session-button) {
    grid-column: 2;
    min-block-size: 3.5rem;
    padding: 0.75rem 1.25rem;
    font-size: 1.125rem;
  }
  summary:focus-visible {
    outline: 3px solid var(--theme-accent);
    outline-offset: 2px;
  }
  dialog {
    max-inline-size: min(26rem, calc(100% - 2rem));
    box-sizing: border-box;
    padding: 1.5rem;
    background: var(--theme-surface);
    color: var(--theme-text);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 55%);
  }
  dialog h2 {
    margin-block-start: 0;
  }
  .dialog-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .session-base {
    display: grid;
    gap: 0.65rem;
    min-inline-size: 0;
    margin-block: 1rem;
  }

  .advanced-model-settings {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 1rem;
    margin-block-end: 0.75rem;
    min-inline-size: 0;
  }

  .supervisor-settings {
    grid-column: 2;
  }

  .provider-control {
    display: grid;
    gap: 0.35rem;
    min-inline-size: 0;
  }

  .executor-settings,
  .supervisor-settings {
    display: grid;
    gap: 0.65rem;
    min-inline-size: 0;
    margin: 0;
    padding: 0.75rem;
    border: 1px solid var(--theme-border);
    border-radius: 0.5rem;
  }

  .session-settings label {
    display: grid;
    gap: 0.35rem;
    min-inline-size: 0;
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
    gap: 1rem;
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

  .session-secondary-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: center;
    gap: 1rem;
    min-inline-size: 0;
  }

  .session-secondary-actions :global(.manage-profiles-button) {
    justify-self: start;
  }
  .session-secondary-actions :global(.save-defaults-button) {
    justify-self: end;
  }

  .skills-profile-error {
    margin: 0;
    font-size: 0.875rem;
  }

  .skills-profile-error {
    color: var(--theme-error);
  }

  @media (max-width: 28rem) {
    .session-setting-labels,
    .session-setting-controls {
      gap: 0.5rem;
    }
    .essential-settings,
    .advanced-model-settings,
    .session-secondary-actions,
    .create-session-actions {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.75rem;
    }
    .create-session-actions :global(.new-session-button) {
      grid-column: auto;
    }
    .supervisor-settings {
      grid-column: auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .verdict-dot.live {
      animation: none;
    }
  }
</style>
