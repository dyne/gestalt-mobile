<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { loadBootstrap } from './features/catalog/bootstrap-client.js';
  import { readDraft, saveDraft } from './features/chat/draft-store.js';
  import { applyDelta, type ChatMessage } from './features/chat/message-store.js';
  import { toPermissionApprovalResponse } from './features/chat/permission-request.js';
  import {
    readUserInputQuestions,
    toUserInputResponse,
  } from './features/chat/user-input-request.js';
  import { createRelayClient } from './features/sessions/relay-client.js';
  import { applyRelayEvent } from './features/sessions/session-events-client.js';
  import { reconnectDelay } from './features/sessions/session-state.js';
  import { readCursor, readSelectedSession, saveCursor, saveSelectedSession } from './features/sessions/session-memory.js';

  let tab = $state<'chat' | 'git' | 'sessions'>('chat');
  let status = $state('Loading relay…');
  let workspaces = $state<Array<{ id: string; name: string }>>([]);
  let profiles = $state<Array<{ name: string }>>([]);
  let sessionId = $state<string | null>(null);
  let sessions = $state<Array<{ id: string; state: string; workspaceId?: string; profile?: string }>>([]);
  let workspaceId = $state('');
  let profile = $state('');
  let message = $state('');
  let activeTurnId = $state<string | null>(null);
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
    dirty: { staged: number; unstaged: number; untracked: number };
    commits: Array<{ hash: string; shortHash: string; subject: string; author: string; authoredAt: string }>;
  } | null>(null);
  let pushConfirmationOpen = $state(false);
  let interactions = $state<Array<{ requestId: string; kind: string; payload: unknown }>>([]);
  let userInputAnswers = $state<Record<string, string>>({});
  const relay = createRelayClient();

  onMount(async () => {
    try {
      const bootstrap = (await loadBootstrap()) as {
        workspaces: Array<{ id: string; name: string }>;
        profiles: Array<{ name: string }>;
        sessions: Array<{ id: string; state: string; workspaceId?: string; profile?: string }>;
      };
      workspaces = bootstrap.workspaces;
      profiles = bootstrap.profiles;
      workspaceId = workspaces[0]?.id ?? '';
      profile = profiles[0]?.name ?? '';
      const remembered = readSelectedSession(localStorage);
      sessionId = bootstrap.sessions.some((session) => session.id === remembered)
        ? remembered
        : (bootstrap.sessions[0]?.id ?? null);
      if (sessionId) cursor = readCursor(localStorage, sessionId);
      if (sessionId) message = readDraft(localStorage, sessionId);
      sessions = bootstrap.sessions;
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
    saveSelectedSession(localStorage, session.id);
    await refreshSessions();
    messages = [];
    cursor = 0;
    message = readDraft(localStorage, session.id);
    connectSession(session.id);
    tab = 'chat';
    status = 'Session started.';
  }

  async function refreshSessions() {
    sessions = (await relay.listSessions()) as typeof sessions;
  }

  function openSession(id: string) {
    sessionId = id;
    saveSelectedSession(localStorage, id);
    messages = [];
    cursor = 0;
    message = readDraft(localStorage, id);
    connectSession(id);
    tab = 'chat';
  }

  async function restoreSession(id: string) {
    await relay.restoreSession(id);
    await refreshSessions();
    openSession(id);
  }

  async function releaseSession(id: string) {
    await relay.releaseSession(id);
    if (sessionId === id) {
      socket?.close();
      sessionId = null;
      saveSelectedSession(localStorage, null);
    }
    await refreshSessions();
    status = 'Session released for SSH resume.';
  }

  async function sendMessage() {
    if (!sessionId || !message.trim()) return;
    const turn = (await relay.startTurn(sessionId, message.trim())) as { activeTurnId?: string };
    activeTurnId = turn.activeTurnId ?? null;
    message = '';
    saveDraft(localStorage, sessionId, '');
    status = 'Codex is working…';
  }

  async function interruptTurn() {
    if (!sessionId || !activeTurnId) return;
    await relay.interruptTurn(sessionId, activeTurnId);
    activeTurnId = null;
    status = 'Codex turn interrupted.';
  }

  async function resyncHistory(id: string, currentSequence: number) {
    const history = (await relay.getHistory(id)) as {
      items: Array<{ id: string; kind: string; text?: string }>;
    };
    messages = history.items
      .filter((item) => (item.kind === 'user' || item.kind === 'agent') && item.text)
      .map((item) => ({
        id: item.id,
        role: item.kind === 'user' ? 'user' : 'assistant',
        text: item.text!,
        complete: true,
      }));
    cursor = currentSequence;
    saveCursor(localStorage, id, cursor);
    status = 'Session history resynchronized.';
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
    pushConfirmationOpen = false;
    await loadGitSummary();
  }

  async function resolveInteraction(requestId: string, decision: 'accept' | 'decline') {
    if (!sessionId) return;
    await relay.respondInteraction(sessionId, requestId, { decision });
    interactions = interactions.filter((interaction) => interaction.requestId !== requestId);
  }

  async function resolveUserInput(interaction: { requestId: string; payload: unknown }) {
    if (!sessionId) return;
    const response = toUserInputResponse(
      readUserInputQuestions(interaction.payload).map((question) => ({
        id: question.id,
        answer: userInputAnswers[question.id] ?? '',
      })),
    );
    await relay.respondInteraction(sessionId, interaction.requestId, response);
    interactions = interactions.filter((item) => item.requestId !== interaction.requestId);
  }

  async function resolvePermissions(interaction: { requestId: string; payload: unknown }) {
    if (!sessionId) return;
    const response = toPermissionApprovalResponse(interaction.payload);
    if (!response) {
      status = 'Codex sent an invalid permission request.';
      return;
    }
    await relay.respondInteraction(sessionId, interaction.requestId, response);
    interactions = interactions.filter((item) => item.requestId !== interaction.requestId);
  }

  function setUserInputAnswer(questionId: string, answer: string) {
    userInputAnswers[questionId] = answer;
  }

  function updateDraft(value: string) {
    message = value;
    if (sessionId) saveDraft(localStorage, sessionId, value);
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
        void resyncHistory(id, typeof envelope.currentSequence === 'number' ? envelope.currentSequence : 0);
        return;
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'interaction.requested') {
        const interaction = envelope.event.payload as { requestId: string; kind: string; payload: unknown };
        if (!interactions.some((item) => item.requestId === interaction.requestId))
          interactions = [...interactions, interaction];
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'turn.completed') activeTurnId = null;
      if (envelope.type === 'relay.event' && envelope.event?.type === 'interaction.resolved') {
        const { requestId } = envelope.event.payload as { requestId: string };
        interactions = interactions.filter((interaction) => interaction.requestId !== requestId);
      }
      cursor = applyRelayEvent(cursor, envelope, (text) => {
        messages = applyDelta(messages, `assistant-${id}`, text);
      });
      saveCursor(localStorage, id, cursor);
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
                {#if interaction.kind === 'userInput'}
                  {@const questions = readUserInputQuestions(interaction.payload)}
                  <form onsubmit={(event) => { event.preventDefault(); void resolveUserInput(interaction); }}>
                    {#each questions as question (question.id)}
                      <label for={`${interaction.requestId}-${question.id}`}>{question.header}: {question.question}</label>
                      <input
                        id={`${interaction.requestId}-${question.id}`}
                        type={question.isSecret ? 'password' : 'text'}
                        value={userInputAnswers[question.id] ?? ''}
                        oninput={(event) => setUserInputAnswer(question.id, event.currentTarget.value)}
                      />
                      {#each question.options as option (option.label)}
                        <button type="button" onclick={() => setUserInputAnswer(question.id, option.label)}>{option.label}</button>
                      {/each}
                    {/each}
                    <button type="submit" disabled={!questions.length}>Send answers</button>
                  </form>
                {:else if interaction.kind === 'permissionsApproval'}
                  <p>Grant the requested permissions for this turn only.</p>
                  <button type="button" onclick={() => void resolvePermissions(interaction)}>Approve</button>
                {:else}
                  <button type="button" onclick={() => void resolveInteraction(interaction.requestId, 'accept')}>Approve</button>
                  <button type="button" onclick={() => void resolveInteraction(interaction.requestId, 'decline')}>Deny</button>
                {/if}
              </article>
            {/each}
          </section>
        {/if}
        <form onsubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <label for="message">Message</label>
          <textarea id="message" value={message} oninput={(event) => updateDraft(event.currentTarget.value)} rows="3" required></textarea>
          <button type="submit">Send</button>
          {#if activeTurnId}<button type="button" onclick={() => void interruptTurn()}>Interrupt</button>{/if}
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
            <p>Changes: {gitSummary.dirty.staged} staged, {gitSummary.dirty.unstaged} unstaged, {gitSummary.dirty.untracked} untracked.</p>
            <button type="button" onclick={() => void refreshGit()}>Fetch</button>
            <button type="button" disabled={!gitSummary.upstream || gitSummary.ahead < 1 || gitSummary.behind > 0} onclick={() => (pushConfirmationOpen = true)}>Push</button>
            {#if pushConfirmationOpen}
              <section aria-label="Confirm push">
                <p>Push HEAD to {gitSummary.upstream}?</p>
                <button type="button" onclick={() => void pushGit()}>Confirm push</button>
                <button type="button" onclick={() => (pushConfirmationOpen = false)}>Cancel</button>
              </section>
            {/if}
            {#if gitSummary.commits.length}
              <h3>Recent commits</h3>
              <ol aria-label="Recent commits">
                {#each gitSummary.commits as commit (commit.hash)}
                  <li><code>{commit.shortHash}</code> {commit.subject} — {commit.author}</li>
                {/each}
              </ol>
            {/if}
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
      <button type="button" onclick={() => void refreshSessions()}>Refresh sessions</button>
      {#if sessions.length}
        <ul aria-label="Saved sessions">
          {#each sessions as session (session.id)}
            <li>
              <span>{session.id} · {session.state}</span>
              <button type="button" onclick={() => openSession(session.id)}>Open</button>
              {#if session.state === 'ready'}
                <button type="button" onclick={() => void releaseSession(session.id)}>Release</button>
              {/if}
              {#if session.state === 'stopped' || session.state === 'released' || session.state === 'attentionRequired'}
                <button type="button" onclick={() => void restoreSession(session.id)}>Restore</button>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p>No saved sessions yet.</p>
      {/if}
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
