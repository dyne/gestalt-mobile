<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { loadBootstrap } from './features/catalog/bootstrap-client.js';
  import { applyDelta, type ChatMessage } from './features/chat/message-store.js';
  import { createRelayClient } from './features/sessions/relay-client.js';
  import { applyRelayEvent } from './features/sessions/session-events-client.js';
  import { reconnectDelay } from './features/sessions/session-state.js';

  let tab = $state<'chat' | 'git' | 'sessions'>('chat');
  let status = $state('Loading relay…');
  let workspaces = $state<Array<{ id: string; name: string }>>([]);
  let profiles = $state<Array<{ name: string }>>([]);
  let sessionId = $state<string | null>(null);
  let workspaceId = $state('');
  let profile = $state('');
  let message = $state('');
  let messages = $state<ChatMessage[]>([]);
  let cursor = $state(0);
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let socketGeneration = 0;
  let gitSummary = $state<{
    available: boolean;
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
  } | null>(null);
  let interactions = $state<Array<{ requestId: string; kind: string; payload: unknown }>>([]);
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
      if (sessionId) connectSession(sessionId);
    } catch {
      status = 'Relay unavailable. Check the server connection.';
    }
  });

  onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  });

  async function startSession() {
    if (!workspaceId || !profile) return;
    const session = (await relay.startSession(workspaceId, profile)) as { id: string };
    sessionId = session.id;
    messages = [];
    cursor = 0;
    connectSession(session.id);
    tab = 'chat';
    status = 'Session started.';
  }

  async function sendMessage() {
    if (!sessionId || !message.trim()) return;
    await relay.startTurn(sessionId, message.trim());
    message = '';
    status = 'Codex is working…';
  }

  async function loadGitSummary() {
    if (!sessionId) return;
    gitSummary = (await relay.getGitSummary(sessionId)) as typeof gitSummary;
  }

  async function refreshGit() {
    if (!sessionId) return;
    await relay.refreshGit(sessionId);
    await loadGitSummary();
  }

  async function pushGit() {
    if (!sessionId) return;
    await relay.pushGit(sessionId);
    await loadGitSummary();
  }

  async function resolveInteraction(requestId: string, decision: 'approved' | 'denied') {
    if (!sessionId) return;
    await relay.respondInteraction(sessionId, requestId, { decision });
    interactions = interactions.filter((interaction) => interaction.requestId !== requestId);
  }

  function connectSession(id: string) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    const generation = ++socketGeneration;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${encodeURIComponent(id)}/events?after=${cursor}`);
    socket.onmessage = (message) => {
      const envelope = JSON.parse(String(message.data));
      if (envelope.type === 'relay.resyncRequired') {
        status = 'Session history needs resync.';
        return;
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'interaction.requested') {
        const interaction = envelope.event.payload as { requestId: string; kind: string; payload: unknown };
        if (!interactions.some((item) => item.requestId === interaction.requestId))
          interactions = [...interactions, interaction];
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'interaction.resolved') {
        const { requestId } = envelope.event.payload as { requestId: string };
        interactions = interactions.filter((interaction) => interaction.requestId !== requestId);
      }
      cursor = applyRelayEvent(cursor, envelope, (text) => {
        messages = applyDelta(messages, `assistant-${id}`, text);
      });
      reconnectAttempt = 0;
    };
    socket.onclose = () => {
      if (generation !== socketGeneration || sessionId !== id) return;
      status = 'Connection interrupted. Reconnecting…';
      reconnectTimer = setTimeout(() => connectSession(id), reconnectDelay(reconnectAttempt++));
    };
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
        <ol aria-label="Chat messages">
          {#each messages as chatMessage (chatMessage.id)}
            <li><strong>{chatMessage.role}:</strong> {chatMessage.text}</li>
          {/each}
        </ol>
        {#if interactions.length}
          <section aria-labelledby="interactions-title">
            <h3 id="interactions-title">Codex needs your decision</h3>
            {#each interactions as interaction (interaction.requestId)}
              <article>
                <p>{interaction.kind}</p>
                <button type="button" onclick={() => void resolveInteraction(interaction.requestId, 'approved')}>Approve</button>
                <button type="button" onclick={() => void resolveInteraction(interaction.requestId, 'denied')}>Deny</button>
              </article>
            {/each}
          </section>
        {/if}
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
    <section aria-labelledby="git-title">
      <h2 id="git-title">Git</h2>
      {#if sessionId}
        <button type="button" onclick={() => void loadGitSummary()}>Load status</button>
        {#if gitSummary}
          {#if gitSummary.available}
            <p>Branch: {gitSummary.branch ?? 'detached'} · upstream: {gitSummary.upstream ?? 'none'}</p>
            <p>Ahead {gitSummary.ahead}; behind {gitSummary.behind}.</p>
            <button type="button" onclick={() => void refreshGit()}>Fetch</button>
            <button type="button" disabled={!gitSummary.upstream || gitSummary.ahead < 1 || gitSummary.behind > 0} onclick={() => void pushGit()}>Push</button>
          {:else}
            <p>This workspace is not a Git repository.</p>
          {/if}
        {/if}
      {:else}
        <p>Select a session to view its workspace status.</p>
      {/if}
    </section>
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
