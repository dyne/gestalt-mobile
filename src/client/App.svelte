<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { loadBootstrap } from './features/catalog/bootstrap-client.js';
  import { toActivity, type HistoryActivity } from './features/chat/activity-summary.js';
  import { readDraft, saveDraft } from './features/chat/draft-store.js';
  import { submitsOnEnter } from './features/chat/keyboard.js';
  import { createMessageCache } from './features/chat/message-cache.js';
  import { fetchAge } from './features/git/fetch-age.js';
  import { applyDelta, completeMessage, type ChatMessage } from './features/chat/message-store.js';
  import { toPermissionApprovalResponse } from './features/chat/permission-request.js';
  import {
    readUserInputQuestions,
    toUserInputResponse,
  } from './features/chat/user-input-request.js';
  import {
    createRelayClient,
    type RelayGitSummary,
    type RelayHistory,
    type RelaySession,
  } from './features/sessions/relay-client.js';
  import { copyText } from './features/sessions/clipboard.js';
  import { createIdempotencyKey } from './features/sessions/idempotency-key.js';
  import { applyRelayEvent } from './features/sessions/session-events-client.js';
  import { reconnectDelay } from './features/sessions/session-state.js';
  import { readCursor, readSelectedSession, saveCursor, saveSelectedSession } from './features/sessions/session-memory.js';
  import { validateStartForm } from './features/sessions/start-form.js';
  import { nextTab, type Tab } from './features/sessions/tab-state.js';

  let tab = $state<Tab>('chat');
  let status = $state('Loading relay…');
  let workspaces = $state<Array<{ id: string; name: string }>>([]);
  let profiles = $state<Array<{ name: string; state: 'ok' | 'not_logged_in' | 'error'; status: string }>>([]);
  let sessionId = $state<string | null>(null);
  let sessions = $state<RelaySession[]>([]);
  let workspaceId = $state('');
  let profile = $state('');
  let startRequestKey = $state<string | null>(null);
  let startingSession = $state(false);
  let message = $state('');
  let activeTurnId = $state<string | null>(null);
  let startingTurn = $state(false);
  let messages = $state<ChatMessage[]>([]);
  let activities = $state<HistoryActivity[]>([]);
  let cursor = $state(0);
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let socketGeneration = 0;
  let gitSummary = $state<RelayGitSummary | null>(null);
  let pushConfirmationOpen = $state(false);
  let gitRefreshing = $state(false);
  let gitError = $state<string | null>(null);
  let interactions = $state<Array<{ requestId: string; kind: string; payload: unknown }>>([]);
  let userInputAnswers = $state<Record<string, string>>({});
  const tabButtons: Partial<Record<Tab, HTMLButtonElement>> = {};
  const relay = createRelayClient();
  const messageCache = createMessageCache();

  onMount(async () => {
    try {
      const bootstrap = await loadBootstrap();
      workspaces = bootstrap.workspaces;
      profiles = bootstrap.profiles;
      workspaceId = workspaces[0]?.id ?? '';
      profile = profiles.find((item) => item.state === 'ok')?.name ?? profiles[0]?.name ?? '';
      const remembered = readSelectedSession(localStorage);
      sessionId = bootstrap.sessions.some((session) => session.id === remembered)
        ? remembered
        : (bootstrap.sessions[0]?.id ?? null);
      if (sessionId) cursor = readCursor(localStorage, sessionId);
      if (sessionId) message = readDraft(localStorage, sessionId);
      if (sessionId) messages = await messageCache.read(sessionId);
      sessions = bootstrap.sessions;
      activeTurnId = sessions.find((session) => session.id === sessionId)?.activeTurnId ?? null;
      status = sessionId ? 'Session ready' : 'Choose a workspace and start a session.';
      if (sessionId) {
        await resyncHistory(sessionId);
        connectSession(sessionId);
      }
    } catch {
      status = 'Relay unavailable. Check the server connection.';
    }
  });

  onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
    socket?.close();
  });

  async function startSession() {
    if (!workspaceId || !profile || startingSession) return;
    const selectedProfile = profiles.find((item) => item.name === profile);
    const errors = validateStartForm({
      workspaceId,
      profile,
      profileState: selectedProfile?.state,
    });
    if (errors.profile) {
      status = errors.profile;
      return;
    }
    startRequestKey ??= createIdempotencyKey();
    startingSession = true;
    status = 'Starting session…';
    try {
      const session = await relay.startSession(workspaceId, profile, startRequestKey);
      startRequestKey = null;
      sessionId = session.id;
      activeTurnId = null;
      saveSelectedSession(localStorage, session.id);
      await refreshSessions();
      messages = [];
      persistMessages(session.id);
      activities = [];
      cursor = 0;
      message = readDraft(localStorage, session.id);
      connectSession(session.id);
      tab = 'chat';
      status = 'Session started.';
    } catch (error) {
      status = `Could not start session: ${error instanceof Error ? error.message : 'Unknown relay error.'}`;
    } finally {
      startingSession = false;
    }
  }

  async function refreshSessions() {
    sessions = await relay.listSessions();
  }

  async function openSession(id: string) {
    sessionId = id;
    saveSelectedSession(localStorage, id);
    messages = await messageCache.read(id);
    activities = [];
    cursor = 0;
    message = readDraft(localStorage, id);
    activeTurnId = sessions.find((session) => session.id === id)?.activeTurnId ?? null;
    try {
      await resyncHistory(id);
      connectSession(id);
      tab = 'chat';
    } catch (error) {
      status = `Could not open session: ${errorMessage(error)}`;
    }
  }

  async function restoreSession(id: string) {
    try {
      await relay.restoreSession(id);
      await refreshSessions();
      await openSession(id);
    } catch (error) {
      status = `Could not restore session: ${errorMessage(error)}`;
    }
  }

  async function releaseSession(id: string) {
    try {
      await relay.releaseSession(id);
      if (sessionId === id) {
        socket?.close();
        sessionId = null;
        activeTurnId = null;
        saveSelectedSession(localStorage, null);
      }
      await refreshSessions();
      status = 'Session released for SSH resume.';
    } catch (error) {
      status = `Could not release session: ${errorMessage(error)}`;
    }
  }

  async function copyResumeCommand(command: string) {
    status = (await copyText(command))
      ? 'SSH resume command copied.'
      : 'Could not copy the SSH resume command.';
  }

  async function sendMessage() {
    if (!sessionId || !message.trim() || activeTurnId || startingTurn) return;
    startingTurn = true;
    try {
      const turn = await relay.startTurn(sessionId, message.trim());
      activeTurnId = turn.activeTurnId ?? null;
      message = '';
      saveDraft(localStorage, sessionId, '');
      status = 'Codex is working…';
    } catch {
      status = 'Message was not sent. Your draft is preserved.';
    } finally {
      startingTurn = false;
    }
  }

  async function interruptTurn() {
    if (!sessionId || !activeTurnId) return;
    try {
      await relay.interruptTurn(sessionId, activeTurnId);
      activeTurnId = null;
      status = 'Codex turn interrupted.';
    } catch (error) {
      status = `Could not interrupt Codex: ${errorMessage(error)}`;
    }
  }

  async function resyncHistory(id: string, fallbackSequence = 0) {
    const history: RelayHistory = await relay.getHistory(id);
    if (sessionId !== id) return;
    messages = history.items
      .filter((item) => (item.kind === 'user' || item.kind === 'agent') && item.text)
      .map((item) => ({
        id: item.id,
        role: item.kind === 'user' ? 'user' : 'assistant',
        text: item.text!,
        complete: true,
      }));
    persistMessages(id);
    activities = history.items.flatMap((item) => {
      const activity = toActivity(item);
      return activity ? [activity] : [];
    });
    cursor = Math.max(cursor, history.currentSequence ?? fallbackSequence);
    saveCursor(localStorage, id, cursor);
    status = 'Session history resynchronized.';
  }

  async function loadGitSummary() {
    if (!sessionId) return;
    gitSummary = await relay.getGitSummary(sessionId);
  }

  async function refreshGit() {
    if (!sessionId) return;
    gitRefreshing = true;
    gitError = null;
    try {
      await relay.refreshGit(sessionId);
      await loadGitSummary();
    } catch {
      gitError = 'Fetch failed. Check the upstream and try again.';
    } finally {
      gitRefreshing = false;
    }
  }

  async function pushGit() {
    if (!sessionId) return;
    gitError = null;
    try {
      await relay.pushGit(sessionId);
      pushConfirmationOpen = false;
      await loadGitSummary();
    } catch {
      gitError = 'Push failed. Refresh the branch status and resolve remote divergence first.';
    }
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

  function persistMessages(id: string): void {
    void messageCache.write(id, messages);
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown relay error.';
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (!submitsOnEnter(event) || activeTurnId || startingTurn || !message.trim()) return;
    event.preventDefault();
    void sendMessage();
  }

  function handleTabKeydown(event: KeyboardEvent): void {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : null;
    if (direction === null) return;
    event.preventDefault();
    tab = nextTab(tab, direction);
    tabButtons[tab]?.focus();
  }

  function connectSession(id: string) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
    socket?.close();
    const generation = ++socketGeneration;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${encodeURIComponent(id)}/events?after=${cursor}`);
    socket.onopen = () => {
      stableConnectionTimer = setTimeout(() => {
        reconnectAttempt = 0;
      }, 30_000);
    };
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
      if (envelope.type === 'relay.event' && envelope.event?.type === 'turnCompleted') {
        activeTurnId = null;
        messages = completeMessage(messages, `assistant-${id}`);
        persistMessages(id);
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'interaction.resolved') {
        const { requestId } = envelope.event.payload as { requestId: string };
        interactions = interactions.filter((interaction) => interaction.requestId !== requestId);
      }
      cursor = applyRelayEvent(cursor, envelope, (text) => {
        messages = applyDelta(messages, `assistant-${id}`, text);
        persistMessages(id);
      });
      saveCursor(localStorage, id, cursor);
    };
    socket.onclose = () => {
      if (generation !== socketGeneration || sessionId !== id) return;
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
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
        {#if activities.length}
          <section aria-labelledby="activities-title">
            <h3 id="activities-title">Activity</h3>
            {#each activities as activity (activity.id)}
              <details>
                <summary>{activity.label}</summary>
                <pre>{activity.detail}</pre>
              </details>
            {/each}
          </section>
        {/if}
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
          <textarea id="message" value={message} oninput={(event) => updateDraft(event.currentTarget.value)} onkeydown={handleComposerKeydown} rows="3" required></textarea>
          <button type="submit" disabled={Boolean(activeTurnId) || startingTurn || !message.trim()}>Send</button>
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
            <p><time datetime={gitSummary.fetchedAt ?? undefined}>{fetchAge(gitSummary.fetchedAt)}</time></p>
            <p>Changes: {gitSummary.dirty.staged} staged, {gitSummary.dirty.unstaged} unstaged, {gitSummary.dirty.untracked} untracked.</p>
            <button type="button" disabled={gitRefreshing} onclick={() => void refreshGit()}>{gitRefreshing ? 'Fetching…' : 'Fetch'}</button>
            {#if gitError}<p role="alert">{gitError}</p>{/if}
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
                  <li>
                    <code>{commit.shortHash}</code> {commit.subject} — {commit.author}
                    <time datetime={commit.authoredAt}> {commit.authoredAt}</time>
                  </li>
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
              <span>{session.threadId ? `Thread ${session.threadId}` : `Relay session ${session.id}`} · {session.state}</span>
              <button type="button" onclick={() => openSession(session.id)}>Open</button>
              {#if session.state === 'ready'}
                <button type="button" onclick={() => void releaseSession(session.id)}>Release</button>
              {/if}
              {#if session.resumeCommand}
                <button type="button" onclick={() => void copyResumeCommand(session.resumeCommand ?? '')}>Copy SSH command</button>
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
          {#each profiles as item (item.name)}
            <option value={item.name} disabled={item.state !== 'ok'}>{item.name}{item.state !== 'ok' ? ` — ${item.status}` : ''}</option>
          {/each}
        </select>
        <button type="submit" disabled={!workspaceId || !profile || startingSession || profiles.find((item) => item.name === profile)?.state !== 'ok'}>{startingSession ? 'Starting…' : 'Start session'}</button>
      </form>
    </section>
  {/if}

  <nav aria-label="Primary">
    <button bind:this={tabButtons.chat} aria-pressed={tab === 'chat'} onkeydown={handleTabKeydown} onclick={() => (tab = 'chat')}>Chat</button>
    <button bind:this={tabButtons.git} aria-pressed={tab === 'git'} onkeydown={handleTabKeydown} onclick={() => (tab = 'git')}>Git</button>
    <button bind:this={tabButtons.sessions} aria-pressed={tab === 'sessions'} onkeydown={handleTabKeydown} onclick={() => (tab = 'sessions')}>Sessions</button>
  </nav>
</main>
