<script lang="ts">
  import { onMount } from 'svelte';

  import { loadBootstrap } from './features/catalog/bootstrap-client.js';
  import { createRelayClient } from './features/sessions/relay-client.js';

  let tab = $state<'chat' | 'git' | 'sessions'>('chat');
  let status = $state('Loading relay…');
  let workspaces = $state<Array<{ id: string; name: string }>>([]);
  let profiles = $state<Array<{ name: string }>>([]);
  let sessionId = $state<string | null>(null);
  let workspaceId = $state('');
  let profile = $state('');
  let message = $state('');
  const relay = createRelayClient();

  onMount(async () => {
    try {
      const bootstrap = (await loadBootstrap()) as {
        workspaces: Array<{ id: string; name: string }>;
        profiles: Array<{ name: string }>;
        sessions: Array<{ id: string }>;
      };
      workspaces = bootstrap.workspaces;
      profiles = bootstrap.profiles;
      workspaceId = workspaces[0]?.id ?? '';
      profile = profiles[0]?.name ?? '';
      sessionId = bootstrap.sessions[0]?.id ?? null;
      status = sessionId ? 'Session ready' : 'Choose a workspace and start a session.';
    } catch {
      status = 'Relay unavailable. Check the server connection.';
    }
  });

  async function startSession() {
    if (!workspaceId || !profile) return;
    const session = (await relay.startSession(workspaceId, profile)) as { id: string };
    sessionId = session.id;
    tab = 'chat';
    status = 'Session started.';
  }

  async function sendMessage() {
    if (!sessionId || !message.trim()) return;
    await relay.startTurn(sessionId, message.trim());
    message = '';
    status = 'Codex is working…';
  }
</script>

<svelte:head>
  <title>Codex Relay</title>
</svelte:head>

<main>
  <header>
    <h1>Codex Relay</h1>
    <p role="status">{status}</p>
  </header>

  {#if tab === 'chat'}
    <section aria-labelledby="chat-title">
      <h2 id="chat-title">Chat</h2>
      {#if sessionId}
        <p>Connected session: {sessionId}</p>
        <form onsubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <label for="message">Message</label>
          <textarea id="message" bind:value={message} rows="3" required></textarea>
          <button type="submit">Send</button>
        </form>
      {:else}
        <p>Start a session from the Sessions tab to chat with Codex.</p>
      {/if}
    </section>
  {:else if tab === 'git'}
    <section aria-labelledby="git-title"><h2 id="git-title">Git</h2><p>Select a session to view its workspace status.</p></section>
  {:else}
    <section aria-labelledby="sessions-title">
      <h2 id="sessions-title">Sessions</h2>
      <form onsubmit={(event) => { event.preventDefault(); void startSession(); }}>
        <label for="workspace">Workspace</label>
        <select id="workspace" bind:value={workspaceId} required>
          {#each workspaces as workspace (workspace.id)}<option value={workspace.id}>{workspace.name}</option>{/each}
        </select>
        <label for="profile">Profile</label>
        <select id="profile" bind:value={profile} required>
          {#each profiles as item (item.name)}<option value={item.name}>{item.name}</option>{/each}
        </select>
        <button type="submit" disabled={!workspaceId || !profile}>Start session</button>
      </form>
    </section>
  {/if}

  <nav aria-label="Primary">
    <button aria-pressed={tab === 'chat'} onclick={() => (tab = 'chat')}>Chat</button>
    <button aria-pressed={tab === 'git'} onclick={() => (tab = 'git')}>Git</button>
    <button aria-pressed={tab === 'sessions'} onclick={() => (tab = 'sessions')}>Sessions</button>
  </nav>
</main>
