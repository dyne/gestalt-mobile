<script lang="ts">
  import type { RelaySession } from './relay-client.js';

  type Workspace = { id: string; name: string };
  type Profile = { name: string; state: 'ok' | 'not_logged_in' | 'error'; status: string };
  type Props = {
    sessions: RelaySession[];
    workspaces: Workspace[];
    profiles: Profile[];
    workspaceId: string;
    profile: string;
    startingSession: boolean;
    onworkspacechange: (value: string) => void;
    onprofilechange: (value: string) => void;
    onrefresh: () => void;
    onopen: (id: string) => void;
    onrelease: (id: string) => void;
    oncopyresume: (command: string) => void;
    onrestore: (id: string) => void;
    onstart: () => void;
  };

  let {
    sessions,
    workspaces,
    profiles,
    workspaceId,
    profile,
    startingSession,
    onworkspacechange,
    onprofilechange,
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
          <span>{session.threadId ? `Thread ${session.threadId}` : `Relay session ${session.id}`} · {session.state}</span>
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
    <button type="submit" disabled={!workspaceId || !profile || startingSession || !selectedProfileReady()}>{startingSession ? 'Starting…' : 'Start session'}</button>
  </form>
</section>
