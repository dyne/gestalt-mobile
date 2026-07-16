<script lang="ts">
  import type { RecentSession, RelaySession, StartSessionSettings } from './relay-client.js';
  import { formatRelativeTime } from './relative-time.js';
  import { managedSessionDetails } from './session-list.js';

  type Workspace = { id: string; name: string };
  type Profile = { name: string; state: 'ok' | 'not_logged_in' | 'error'; status: string };
  type Props = {
    sessions: RelaySession[];
    recentSessions: RecentSession[];
    workspaces: Workspace[];
    profiles: Profile[];
    workspaceId: string;
    profile: string;
    sandbox: StartSessionSettings['sandbox'] | '';
    approvalPolicy: NonNullable<StartSessionSettings['approvalPolicy']>;
    startingSession: boolean;
    onworkspacechange: (value: string) => void;
    onprofilechange: (value: string) => void;
    onsandboxchange: (value: StartSessionSettings['sandbox'] | '') => void;
    onapprovalpolicychange: (value: NonNullable<StartSessionSettings['approvalPolicy']>) => void;
    onopen: (id: string) => void;
    onforget: (id: string) => void;
    oncopyresume: (command: string) => void;
    onstart: () => void;
  };

  let {
    sessions,
    recentSessions,
    workspaces,
    profiles,
    workspaceId,
    profile,
    sandbox,
    approvalPolicy,
    startingSession,
    onworkspacechange,
    onprofilechange,
    onsandboxchange,
    onapprovalpolicychange,
    onopen,
    onforget,
    oncopyresume,
    onstart,
  }: Props = $props();

  const selectedProfileReady = () => profiles.find((item) => item.name === profile)?.state === 'ok';
</script>

<section aria-labelledby="sessions-title">
  <h2 id="sessions-title">Sessions</h2>
  {#if sessions.length}
    <ul aria-label="Saved sessions">
      {#each sessions as session (session.id)}
        {@const details = managedSessionDetails(session)}
        <li>
          {#if details.updatedAt !== null}
            <time datetime={new Date(details.updatedAt).toISOString()}>
              {formatRelativeTime(details.updatedAt)}
            </time>
          {:else}
            <div>{formatRelativeTime(null)}</div>
          {/if}
          <code>{details.threadId ?? 'Thread pending'}</code>
          <div>{details.workspacePath}</div>
          {#if session.state === 'ready' || session.state === 'turnActive'}
            <span>running</span>
          {/if}
          <button type="button" onclick={() => onopen(session.id)}>Open</button>
          {#if session.resumeCommand}
            <button type="button" onclick={() => oncopyresume(session.resumeCommand ?? '')}>
              Copy resume command
            </button>
          {/if}
          <button type="button" onclick={() => onforget(session.id)}>Forget</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p>No saved sessions yet.</p>
  {/if}
  <form onsubmit={(event) => { event.preventDefault(); onstart(); }}>
    <div class="form-row">
      <label for="workspace">Workspace</label>
      <label for="profile">Profile</label>
      <select id="workspace" value={workspaceId} onchange={(event) => onworkspacechange(event.currentTarget.value)} required>
        {#each workspaces as workspace (workspace.id)}
          <option value={workspace.id}>{workspace.name}</option>
        {/each}
      </select>
      <select id="profile" value={profile} onchange={(event) => onprofilechange(event.currentTarget.value)} required>
        {#each profiles as item (item.name)}
          <option value={item.name} disabled={item.state !== 'ok'}>{item.name}{item.state !== 'ok' ? ` — ${item.status}` : ''}</option>
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
    <button type="submit" disabled={!workspaceId || !profile || startingSession || !selectedProfileReady()}>
      {startingSession ? 'Starting…' : 'New session'}
    </button>
  </form>
  <section aria-labelledby="last-sessions-title">
    <h3 id="last-sessions-title">Last sessions</h3>
    {#if recentSessions.length}
      <ul aria-label="Last sessions">
        {#each recentSessions as session (session.id)}
          <li>
            {#if session.recencyAt !== null}
              <time datetime={new Date(session.recencyAt * 1000).toISOString()}>{formatRelativeTime(session.recencyAt * 1000)}</time>
            {:else}
              <div>{formatRelativeTime(null)}</div>
            {/if}
            <div>{session.cwd}</div>
            <code>{session.id}</code>
          </li>
        {/each}
      </ul>
    {:else}
      <p>No recent Codex sessions found.</p>
    {/if}
  </section>
</section>

<style>
  .form-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    margin-block-end: 0.75rem;
  }
</style>
