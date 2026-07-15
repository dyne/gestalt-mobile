<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import AppHeader from './components/AppHeader.svelte';
  import ActivityList from './features/chat/ActivityList.svelte';
  import InteractionList from './features/chat/InteractionList.svelte';
  import Composer from './features/chat/Composer.svelte';
  import MessageList from './features/chat/MessageList.svelte';
  import { loadBootstrap } from './features/catalog/bootstrap-client.js';
  import { toActivity, type HistoryActivity } from './features/chat/activity-summary.js';
  import { submitsOnEnter } from './features/chat/keyboard.js';
  import { createMessageCache } from './features/chat/message-cache.js';
  import GitView from './features/git/GitView.svelte';
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
    type RecentSession,
    type RelaySession,
  } from './features/sessions/relay-client.js';
  import { copyText } from './features/sessions/clipboard.js';
  import { createIdempotencyKey } from './features/sessions/idempotency-key.js';
  import { applyRelayEvent } from './features/sessions/session-events-client.js';
  import { reconnectDelay } from './features/sessions/session-state.js';
  import { createSessionCache } from './features/sessions/session-cache.js';
  import SessionsView from './features/sessions/SessionsView.svelte';
  import { validateStartForm } from './features/sessions/start-form.js';
  import type { Tab } from './features/sessions/tab-state.js';
  import BottomNavigation from './features/sessions/BottomNavigation.svelte';

  let tab = $state<Tab>('chat');
  let status = $state('Loading relay…');
  let workspaces = $state<Array<{ id: string; name: string }>>([]);
  let profiles = $state<Array<{ name: string; state: 'ok' | 'not_logged_in' | 'error'; status: string }>>([]);
  let sessionId = $state<string | null>(null);
  let sessions = $state<RelaySession[]>([]);
  let recentSessions = $state<RecentSession[]>([]);
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
  const relay = createRelayClient();
  const messageCache = createMessageCache();
  const sessionCache = createSessionCache();

  onMount(async () => {
    try {
      const bootstrap = await loadBootstrap();
      workspaces = bootstrap.workspaces;
      profiles = bootstrap.profiles;
      workspaceId = workspaces[0]?.id ?? '';
      profile = profiles.find((item) => item.state === 'ok')?.name ?? profiles[0]?.name ?? '';
      const remembered = await sessionCache.readSelectedSession();
      sessionId = bootstrap.sessions.some((session) => session.id === remembered)
        ? remembered
        : (bootstrap.sessions[0]?.id ?? null);
      if (sessionId) cursor = await sessionCache.readCursor(sessionId);
      if (sessionId) message = await sessionCache.readDraft(sessionId);
      if (sessionId) messages = await messageCache.read(sessionId);
      sessions = bootstrap.sessions;
      void refreshRecentSessions();
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
      void sessionCache.saveSelectedSession(session.id);
      await refreshSessions();
      messages = [];
      persistMessages(session.id);
      activities = [];
      cursor = 0;
      message = await sessionCache.readDraft(session.id);
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

  async function refreshRecentSessions() {
    try {
      recentSessions = await relay.listRecentSessions();
    } catch {
      recentSessions = [];
    }
  }

  async function refreshSessionLists() {
    try {
      await Promise.all([refreshSessions(), refreshRecentSessions()]);
    } catch (error) {
      status = `Could not refresh sessions: ${errorMessage(error)}`;
    }
  }

  async function openSession(id: string) {
    sessionId = id;
    void sessionCache.saveSelectedSession(id);
    messages = await messageCache.read(id);
    activities = [];
    cursor = 0;
    message = await sessionCache.readDraft(id);
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
        void sessionCache.saveSelectedSession(null);
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
      void sessionCache.saveDraft(sessionId, '');
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
    void sessionCache.saveCursor(id, cursor);
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
    if (sessionId) void sessionCache.saveDraft(sessionId, value);
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

  function connectSession(id: string) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
    socket?.close();
    const generation = ++socketGeneration;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${encodeURIComponent(id)}/events?after=${cursor}`);
    socket.onopen = () => {
      if (generation !== socketGeneration || sessionId !== id) return;
      status = 'Session connected.';
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
      if (envelope.type === 'relay.event' && envelope.event?.type === 'activity.updated') {
        const activity = envelope.event.payload as HistoryActivity;
        if (typeof activity.id === 'string' && typeof activity.label === 'string' && typeof activity.detail === 'string')
          activities = [...activities.filter((item) => item.id !== activity.id), activity];
      }
      cursor = applyRelayEvent(cursor, envelope, (text) => {
        messages = applyDelta(messages, `assistant-${id}`, text);
        persistMessages(id);
      }, () => {
        void resyncHistory(id);
      });
      void sessionCache.saveCursor(id, cursor);
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
  <AppHeader {status} />

  {#if tab === 'chat'}
    <section aria-labelledby="chat-title">
      <h2 id="chat-title">Chat</h2>
      {#if sessionId}
        <p>Connected session: {sessionId}</p>
        <MessageList {messages} />
        <ActivityList {activities} />
        <InteractionList {interactions} answers={userInputAnswers} onanswer={setUserInputAnswer} onuserinput={(interaction) => void resolveUserInput(interaction)} onpermission={(interaction) => void resolvePermissions(interaction)} ondecision={(id, decision) => void resolveInteraction(id, decision)} />
        <Composer {message} activeTurnId={activeTurnId} starting={startingTurn} onchange={updateDraft} onsend={() => void sendMessage()} oninterrupt={() => void interruptTurn()} />
      {:else}
        <p>Start a session from the Sessions tab to chat with Codex.</p>
      {/if}
    </section>
  {:else if tab === 'git'}
    <GitView
      {sessionId}
      summary={gitSummary}
      refreshing={gitRefreshing}
      error={gitError}
      confirmingPush={pushConfirmationOpen}
      onload={() => void loadGitSummary()}
      onrefresh={() => void refreshGit()}
      onopenpushconfirmation={() => (pushConfirmationOpen = true)}
      onpush={() => void pushGit()}
      oncancelpush={() => (pushConfirmationOpen = false)}
    />
  {:else}
    <SessionsView
      {sessions}
      {recentSessions}
      {workspaces}
      {profiles}
      {workspaceId}
      {profile}
      {startingSession}
      onworkspacechange={(value) => (workspaceId = value)}
      onprofilechange={(value) => (profile = value)}
      onrefresh={() => void refreshSessionLists()}
      onopen={openSession}
      onrelease={(id) => void releaseSession(id)}
      oncopyresume={(command) => void copyResumeCommand(command)}
      onrestore={(id) => void restoreSession(id)}
      onstart={() => void startSession()}
    />
  {/if}

  <BottomNavigation activeTab={tab} onselect={(next) => (tab = next)} />
</main>
