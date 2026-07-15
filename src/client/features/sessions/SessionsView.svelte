<script lang="ts">
  import type { RecentSession, RelaySession, StartSessionSettings } from './relay-client.js';
  import { formatRelativeTime } from './relative-time.js';

  type Workspace = { id: string; name: string };
  type Profile = { name: string; state: 'ok' | 'not_logged_in' | 'error'; status: string };
  type Props = {
    sessions: RelaySession[];
    recentSessions: RecentSession[];
    workspaces: Workspace[];
    profiles: Profile[];
    workspaceId: string;
    profile: string;
    model: string;
    sandbox: StartSessionSettings['sandbox'] | '';
    approvalPolicy: NonNullable<StartSessionSettings['approvalPolicy']>;
    startingSession: boolean;
    onworkspacechange: (value: string) => void;
    onprofilechange: (value: string) => void;
    onmodelchange: (value: string) => void;
    onsandboxchange: (value: StartSessionSettings['sandbox'] | '') => void;
    onapprovalpolicychange: (value: NonNullable<StartSessionSettings['approvalPolicy']>) => void;
    onrefresh: () => void;
    onopen: (id: string) => void;
    onrelease: (id: string) => void;
    oncopyresume: (command: string) => void;
    onrestore: (id: string) => void;
    onstart: () => void;
  };

  let {
    sessions,
    recentSessions,
    workspaces,
    profiles,
    workspaceId,
    profile,
    model,
    sandbox,
    approvalPolicy,
    startingSession,
    onworkspacechange,
    onprofilechange,
    onmodelchange,
    onsandboxchange,
    onapprovalpolicychange,
    onrefresh,
    onopen,
    onrelease,
    oncopyresume,
    onrestore,
    onstart,
  }: Props = $props();

  const selectedProfileReady = () => profiles.find((item) => item.name === profile)?.state === 'ok';
</script>

<section aria-labelledby="sessions-title">
  <h2 id="sessions-title">Sessions</h2>
  <button type="button" onclick={onrefresh}>Refresh sessions</button>
  {#if sessions.length}
    <ul aria-label="Saved sessions">
      {#each sessions as session (session.id)}
        <li>
          <span>{session.threadId ? `Session ${session.threadId}` : `Relay session ${session.id}`} · {session.state}</span>
          <button type="button" onclick={() => onopen(session.id)}>Open</button>
          {#if session.state === 'ready'}
            <button type="button" onclick={() => onrelease(session.id)}>Release</button>
          {/if}
          {#if session.resumeCommand}
            <button type="button" onclick={() => oncopyresume(session.resumeCommand ?? '')}>Copy SSH command</button>
          {/if}
          {#if session.state === 'stopped' || session.state === 'released' || session.state === 'attentionRequired'}
            <button type="button" onclick={() => onrestore(session.id)}>Restore</button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p>No saved sessions yet.</p>
  {/if}
  <form onsubmit={(event) => { event.preventDefault(); onstart(); }}>
    <label for="workspace">Workspace</label>
    <select id="workspace" value={workspaceId} onchange={(event) => onworkspacechange(event.currentTarget.value)} required>
      {#each workspaces as workspace (workspace.id)}<option value={workspace.id}>{workspace.name}</option>{/each}
    </select>
    <label for="profile">Profile</label>
    <select id="profile" value={profile} onchange={(event) => onprofilechange(event.currentTarget.value)} required>
      {#each profiles as item (item.name)}
        <option value={item.name} disabled={item.state !== 'ok'}>{item.name}{item.state !== 'ok' ? ` — ${item.status}` : ''}</option>
      {/each}
    </select>
    <label for="model">Model</label>
    <input id="model" value={model} oninput={(event) => onmodelchange(event.currentTarget.value)} />
    <label for="sandbox">Sandbox</label>
    <select id="sandbox" value={sandbox} onchange={(event) => onsandboxchange(event.currentTarget.value as StartSessionSettings['sandbox'] | '')}>
      <option value="">Codex default</option>
      <option value="read-only">read-only</option>
      <option value="workspace-write">workspace-write</option>
      <option value="danger-full-access">danger-full-access</option>
    </select>
    <label for="approval-policy">Approval policy</label>
    <select id="approval-policy" value={approvalPolicy} onchange={(event) => onapprovalpolicychange(event.currentTarget.value as NonNullable<StartSessionSettings['approvalPolicy']>)}>
      <option value="untrusted">untrusted</option>
      <option value="on-request">on-request</option>
      <option value="never">never</option>
    </select>
    <button type="submit" disabled={!workspaceId || !profile || startingSession || !selectedProfileReady()}>{startingSession ? 'Starting…' : 'Start session'}</button>
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
