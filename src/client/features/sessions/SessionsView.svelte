<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { RecentSession, RelaySession, StartSessionSettings } from './relay-client.js';
  import { formatRelativeTime } from './relative-time.js';
  import { managedSessionDetails } from './session-list.js';

  type Workspace = { id: string; name: string };
  type Props = {
    sessions: RelaySession[];
    recentSessions: RecentSession[];
    workspaces: Workspace[];
    workspaceId: string;
    sandbox: StartSessionSettings['sandbox'] | '';
    approvalPolicy: NonNullable<StartSessionSettings['approvalPolicy']>;
    startingSession: boolean;
    onworkspacechange: (value: string) => void;
    onsandboxchange: (value: StartSessionSettings['sandbox'] | '') => void;
    onapprovalpolicychange: (value: NonNullable<StartSessionSettings['approvalPolicy']>) => void;
    onopen: (id: string) => void;
    onopenrecent: (session: RecentSession) => void;
    onforget: (id: string) => void;
    oncopyresume: (command: string) => void;
    onstart: () => void;
  };

  let {
    sessions,
    recentSessions,
    workspaces,
    workspaceId,
    sandbox,
    approvalPolicy,
    startingSession,
    onworkspacechange,
    onsandboxchange,
    onapprovalpolicychange,
    onopen,
    onopenrecent,
    onforget,
    oncopyresume,
    onstart,
  }: Props = $props();

</script>

<section aria-labelledby="sessions-title">
  <h2 id="sessions-title" class="visually-hidden">Sessions</h2>
  {#if sessions.length}
    <ul class="session-list" aria-label="Saved sessions">
      {#each sessions as session (session.id)}
        {@const details = managedSessionDetails(session)}
        <li class="managed-session">
          <div class="session-details">
            {#if details.updatedAt !== null}
              <time datetime={new Date(details.updatedAt).toISOString()}>
                {formatRelativeTime(details.updatedAt)}
              </time>
            {:else}
              <div>{formatRelativeTime(null)}</div>
            {/if}
            <div class="workspace-path">{details.workspacePath}</div>
            {#if session.state === 'ready' || session.state === 'turnActive'}
              <span>running</span>
            {/if}
          </div>
          <div class="session-actions">
            <button type="button" onclick={() => onopen(session.id)}>Open</button>
            {#if session.resumeCommand}
              <button type="button" onclick={() => oncopyresume(session.resumeCommand ?? '')}>
                Copy
              </button>
            {/if}
            <button type="button" onclick={() => onforget(session.id)}>Forget</button>
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p>No saved sessions yet.</p>
  {/if}
  <form onsubmit={(event) => { event.preventDefault(); onstart(); }}>
    <div class="form-row">
      <label for="workspace">Workspace</label>
      <select id="workspace" value={workspaceId} onchange={(event) => onworkspacechange(event.currentTarget.value)} required>
        {#each workspaces as workspace (workspace.id)}
          <option value={workspace.id}>{workspace.name}</option>
        {/each}
      </select>
    </div>
    <div class="form-row">
      <label for="sandbox">Sandbox</label>
      <label for="approval-policy">Approval policy</label>
      <select id="sandbox" value={sandbox} onchange={(event) => onsandboxchange(event.currentTarget.value as StartSessionSettings['sandbox'] | '')}>
        <option value="">Codex default</option>
        <option value="read-only">read-only</option>
        <option value="workspace-write">workspace-write</option>
        <option value="danger-full-access">danger-full-access</option>
      </select>
      <select id="approval-policy" value={approvalPolicy} onchange={(event) => onapprovalpolicychange(event.currentTarget.value as NonNullable<StartSessionSettings['approvalPolicy']>)}>
        <option value="untrusted">untrusted</option>
        <option value="on-request">on-request</option>
        <option value="never">never</option>
      </select>
    </div>
    <button type="submit" disabled={!workspaceId || startingSession}>
      {startingSession ? 'Starting…' : 'New session'}
    </button>
  </form>
  <section aria-labelledby="recent-sessions-title">
    <h3 id="recent-sessions-title">Recent sessions</h3>
    {#if recentSessions.length}
      <ul class="session-list recent-session-list" aria-label="Recent sessions">
        {#each recentSessions as session (session.id)}
          <li class="recent-session">
            <div class="session-details">
              {#if session.recencyAt !== null}
                <time datetime={new Date(session.recencyAt * 1000).toISOString()}>{formatRelativeTime(session.recencyAt * 1000)}</time>
              {:else}
                <div>{formatRelativeTime(null)}</div>
              {/if}
              <div class="workspace-path">{session.cwd}</div>
            </div>
            <button type="button" onclick={() => onopenrecent(session)}>Open</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p>No recent Codex sessions found.</p>
    {/if}
  </section>
</section>

<style>
  .session-list {
    display: grid;
    gap: 1rem;
    margin-block: 0 1.5rem;
    padding-inline: 0;
    list-style: none;
  }

  .managed-session {
    display: grid;
    gap: 0.5rem;
  }

  .session-details {
    min-inline-size: 0;
  }

  .workspace-path {
    overflow-wrap: anywhere;
  }

  .session-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .recent-session {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem;
    align-items: start;
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    margin-block-end: 0.75rem;
  }
</style>
