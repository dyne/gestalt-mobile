<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import FilesystemTree from '../filesystem-tree/FilesystemTree.svelte';
  import { findTreeNode, treeNodePolicies } from '../filesystem-tree/tree-state.js';
  import type { RecentSession, RelaySession, RelaySkillProfile, StartSessionSettings } from './relay-client.js';
  import { formatRelativeTime } from './relative-time.js';
  import { displayWorkspacePath, managedSessionDetails } from './session-list.js';

  type Props = {
    sessions: RelaySession[];
    recentSessions: RecentSession[];
    workspaceTree: WorkspaceOption[];
    workspaceId: string;
    expandedIds: ReadonlySet<string>;
    sandbox: NonNullable<StartSessionSettings['sandbox']>;
    approvalPolicy: NonNullable<StartSessionSettings['approvalPolicy']>;
    skillProfiles: RelaySkillProfile[];
    selectedSkillProfile: string;
    skillProfileError: string;
    startingSession: boolean;
    onworkspacechange: (value: string) => void;
    onexpandedchange: (value: Set<string>) => void;
    onsandboxchange: (value: NonNullable<StartSessionSettings['sandbox']>) => void;
    onapprovalpolicychange: (value: NonNullable<StartSessionSettings['approvalPolicy']>) => void;
    onskillprofilechange: (value: string) => void;
    onmanageprofiles: (trigger: HTMLButtonElement) => void;
    onopen: (id: string) => void;
    onclose: (id: string) => void;
    onopenrecent: (session: RecentSession) => void;
    onforget: (id: string) => void;
    oncopyresume: (command: string) => void;
    onstart: () => void;
  };

  let {
    sessions,
    recentSessions,
    workspaceTree,
    workspaceId,
    expandedIds,
    sandbox,
    approvalPolicy,
    skillProfiles,
    selectedSkillProfile,
    skillProfileError,
    startingSession,
    onworkspacechange,
    onexpandedchange,
    onsandboxchange,
    onapprovalpolicychange,
    onskillprofilechange,
    onmanageprofiles,
    onopen,
    onclose,
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
          <li class="managed-session open-session">
            <div class="session-actions">
              <button type="button" onclick={() => onclose(session.id)}>Close</button>
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
              {#if session.effectiveSkillSelection?.selectedProfileName}
                <span class="profile-badge">Skills profile: {session.effectiveSkillSelection.selectedProfileName}</span>
              {/if}
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
            <button type="button" onclick={() => onopen(session.id)}>Open</button>
            <button type="button" onclick={() => onforget(session.id)}>Forget</button>
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
            {#if session.effectiveSkillSelection?.selectedProfileName}
              <span class="profile-badge">Skills profile: {session.effectiveSkillSelection.selectedProfileName}</span>
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
      <div class="tree-panel">
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
            onsandboxchange(event.currentTarget.value as NonNullable<StartSessionSettings['sandbox']>)}
        >
          <option value="workspace-write">workspace-write</option>
          <option value="read-only">read-only</option>
          <option value="danger-full-access">danger-full-access</option>
        </select>
        <select
          id="approval-policy"
          value={approvalPolicy}
          onchange={(event) =>
            onapprovalpolicychange(
              event.currentTarget.value as NonNullable<StartSessionSettings['approvalPolicy']>,
            )}
        >
          <option value="untrusted">untrusted</option>
          <option value="on-request">on-request</option>
          <option value="never">never</option>
        </select>
      </div>
      {#if skillProfileError}<p class="skills-profile-error" role="alert">{skillProfileError}</p>{/if}
      <div class="session-secondary-actions">
        <button id="manage-skill-profiles" type="button" onclick={(event) => onmanageprofiles(event.currentTarget)}>Manage skill profiles</button>
        <div class="model-control">
          <span>Model:</span>
          <button type="button" disabled>Codex default</button>
        </div>
      </div>
      <div class="session-submit-row">
        <button
          class="new-session-button"
          type="submit"
          disabled={!selectedWorkspace || startingSession}
        >
          {startingSession ? 'Creating…' : 'Create session'}
        </button>
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
            </div>
            <div class="session-actions">
              <button type="button" onclick={() => onopenrecent(session)}>Open</button>
              <button type="button" onclick={() => oncopyresume(session.resumeCommand)}>Copy</button
              >
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

  .managed-session {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.75rem;
    align-items: start;
    inline-size: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    border: 1px solid CanvasText;
    border-radius: 0.5rem;
  }

  .open-session {
    border-inline-start: 0.3rem solid Highlight;
    background: color-mix(in srgb, Highlight 12%, Canvas);
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
    background: color-mix(in srgb, Highlight 14%, Canvas);
    color: CanvasText;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }

  .session-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
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

  .tree-panel {
    box-sizing: border-box;
    min-inline-size: 0;
    max-block-size: min(22rem, 48vh);
    padding: 0.35rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
    border-radius: 0.6rem;
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
    min-inline-size: 0;
  }

  .session-secondary-actions,
  .model-control,
  .session-submit-row {
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

  .session-submit-row {
    justify-content: flex-end;
  }

  .skills-profile-error {
    margin: 0;
    font-size: 0.875rem;
  }

  .skills-profile-error {
    color: #8a1c14;
  }

  .new-session-button {
    inline-size: auto;
    color: Canvas;
    font-weight: 700;
    background: CanvasText;
    border-color: CanvasText;
    box-shadow: inset 0 0.15rem 0 color-mix(in srgb, Canvas 45%, transparent);
  }

  @media (max-width: 28rem) {
    .tree-panel {
      padding: 0.2rem;
    }

    .model-control { margin-inline-start: 0; }
  }
</style>
