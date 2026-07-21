<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import AppHeader from './components/AppHeader.svelte';
  import ActivityList from './features/chat/ActivityList.svelte';
  import InteractionList from './features/chat/InteractionList.svelte';
  import Composer from './features/chat/Composer.svelte';
  import MessageList from './features/chat/MessageList.svelte';
  import {
    loadBootstrap,
    type WorkspaceOption,
  } from './features/catalog/bootstrap-client.js';
  import { toActivity, type HistoryActivity } from './features/chat/activity-summary.js';
  import { submitsOnEnter } from './features/chat/keyboard.js';
  import { createMessageCache } from './features/chat/message-cache.js';
  import { relayFeedback, type RelayFeedbackCode } from './features/feedback/relay-messages.js';
  import { createToastQueue } from './features/feedback/toast-queue.js';
  import ToastEvidence from './features/feedback/ToastEvidence.svelte';
  import ToastViewport from './features/feedback/ToastViewport.svelte';
  import FilesystemTreeEvidence from './features/filesystem-tree/FilesystemTreeEvidence.svelte';
  import {
    defaultExpandedIds,
    findTreeNode,
    refreshSelection,
    treeNodePolicies,
  } from './features/filesystem-tree/tree-state.js';
  import GitView from './features/git/GitView.svelte';
  import { selectAfterClone } from './features/git/post-clone-selection.js';
  import {
    appendUserMessage,
    applyDelta,
    completeMessage,
    type ChatMessage,
  } from './features/chat/message-store.js';
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
    type StartSessionSettings,
  } from './features/sessions/relay-client.js';
  import { copyText } from './features/sessions/clipboard.js';
  import { createIdempotencyKey } from './features/sessions/idempotency-key.js';
  import { applyRelayEvent } from './features/sessions/session-events-client.js';
  import { reconnectDelay, turnReadiness } from './features/sessions/session-state.js';
  import { createSessionCache } from './features/sessions/session-cache.js';
  import SessionsView from './features/sessions/SessionsView.svelte';
  import { validateStartForm } from './features/sessions/start-form.js';
  import type { Tab } from './features/sessions/tab-state.js';
  import BottomNavigation from './features/sessions/BottomNavigation.svelte';
  import { displayWorkspacePath } from './features/sessions/session-list.js';

  let tab = $state<Tab>('sessions');
  let status = $state('Loading relay…');
  type ThemePreference = 'system' | 'light' | 'dark';
  let theme = $state<ThemePreference>('system');
  let workspaceTree = $state<WorkspaceOption[]>([]);
  let sessionWorkspaceId = $state('');
  let sessionExpandedIds = $state<Set<string>>(new Set());
  let sessionId = $state<string | null>(null);
  let sessions = $state<RelaySession[]>([]);
  let chatEnabled = $derived(
    sessions.some(
      (session) =>
        session.id === sessionId && (session.state === 'ready' || session.state === 'turnActive'),
    ),
  );
  let recentSessions = $state<RecentSession[]>([]);
  let sandbox = $state<StartSessionSettings['sandbox'] | ''>('');
  let approvalPolicy = $state<NonNullable<StartSessionSettings['approvalPolicy']>>('on-request');
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
  let historyRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let historyRefreshInFlight = false;
  let reconnectAttempt = 0;
  let socketGeneration = 0;
  let gitSummary = $state<RelayGitSummary | null>(null);
  let gitWorkspaceId = $state<string | null>(null);
  let gitExpandedIds = $state<Set<string>>(new Set());
  let pushConfirmationOpen = $state(false);
  let gitRefreshing = $state(false);
  let gitCheckingOut = $state(false);
  let gitCloning = $state(false);
  let gitError = $state<string | null>(null);
  let gitCloneStatus = $state<string | null>(null);
  let refreshRequestKey = $state<string | null>(null);
  let pushRequestKey = $state<string | null>(null);
  let gitSummaryRequest = 0;
  let interactions = $state<Array<{ requestId: string; kind: string; payload: unknown }>>([]);
  let userInputAnswers = $state<Record<string, string>>({});
  const relay = createRelayClient();
  const messageCache = createMessageCache();
  const sessionCache = createSessionCache();
  const toastQueue = createToastQueue();
  const evidenceContext = new URLSearchParams(location.search).get('tree-evidence');
  const toastEvidence = new URLSearchParams(location.search).get('toast-evidence');

  onMount(async () => {
    const savedTheme = localStorage.getItem('gestalt-mobile.theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system')
      setTheme(savedTheme);
    if (
      evidenceContext === 'sessions' ||
      evidenceContext === 'git' ||
      toastEvidence === 'error' ||
      toastEvidence === 'stacked'
    )
      return;
    historyRefreshTimer = setInterval(reconcileVisibleHistory, 2_000);
    document.addEventListener('visibilitychange', reconcileVisibleHistory);
    window.addEventListener('focus', reconcileVisibleHistory);
    try {
      const bootstrap = await loadBootstrap();
      sessionWorkspaceId =
        refreshSelection(
          sessionWorkspaceId || null,
          workspaceTree,
          bootstrap.workspaces,
          treeNodePolicies.sessionBase,
        ) ?? '';
      workspaceTree = bootstrap.workspaces;
      sessionExpandedIds = defaultExpandedIds(workspaceTree);
      gitExpandedIds = defaultExpandedIds(workspaceTree);
      const remembered = await sessionCache.readSelectedSession();
      sessionId = bootstrap.sessions.some((session) => session.id === remembered)
        ? remembered
        : (bootstrap.sessions[0]?.id ?? null);
      if (sessionId) cursor = await sessionCache.readCursor(sessionId);
      if (sessionId) message = await sessionCache.readDraft(sessionId);
      if (sessionId) messages = await messageCache.read(sessionId);
      sessions = bootstrap.sessions;
      interactions =
        sessions.find((session) => session.id === sessionId)?.pendingInteractions ?? [];
      void refreshRecentSessions();
      activeTurnId = sessions.find((session) => session.id === sessionId)?.activeTurnId ?? null;
      status = sessionId ? turnReadiness(activeTurnId) : 'Choose a workspace and start a session.';
      if (sessionId) {
        await resyncHistory(sessionId);
        connectSession(sessionId);
      }
    } catch (error) {
      status = reportRelayError(error, 'RELAY_UNAVAILABLE');
    }
  });

  function setTheme(value: ThemePreference): void {
    theme = value;
    if (value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = value;
    localStorage.setItem('gestalt-mobile.theme', value);
  }

  onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (stableConnectionTimer) clearTimeout(stableConnectionTimer);
    if (historyRefreshTimer) clearInterval(historyRefreshTimer);
    document.removeEventListener('visibilitychange', reconcileVisibleHistory);
    window.removeEventListener('focus', reconcileVisibleHistory);
    socket?.close();
  });

  async function startSession() {
    if (!sessionWorkspaceId || startingSession) return;
    const errors = validateStartForm({
      workspaceId: sessionWorkspaceId,
      profile: 'default',
      profileState: 'ok',
    });
    if (errors.profile) {
      status = errors.profile;
      return;
    }
    startRequestKey ??= createIdempotencyKey();
    startingSession = true;
    status = 'Starting session…';
    try {
      const session = await relay.startSession(
        sessionWorkspaceId,
        {
          sandbox: sandbox || undefined,
          approvalPolicy,
        },
        startRequestKey,
      );
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
      scrollChatToBottom();
      status = 'Session started.';
    } catch (error) {
      status = reportRelayError(error, 'SESSION_START_FAILED');
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
      status = reportRelayError(error, 'SESSION_REFRESH_FAILED');
    }
  }

  async function openSession(id: string) {
    status = 'Opening session…';
    try {
      const existing = sessions.find((session) => session.id === id);
      if (existing && existing.state !== 'ready' && existing.state !== 'turnActive') {
        const restored = await relay.restoreSession(id);
        sessions = sessions.map((session) => (session.id === id ? restored : session));
      }
      sessionId = id;
      void sessionCache.saveSelectedSession(id);
      messages = await messageCache.read(id);
      activities = [];
      cursor = 0;
      message = await sessionCache.readDraft(id);
      activeTurnId = sessions.find((session) => session.id === id)?.activeTurnId ?? null;
      interactions = sessions.find((session) => session.id === id)?.pendingInteractions ?? [];
      tab = 'chat';
      scrollChatToBottom();
      await resyncHistory(id);
      connectSession(id);
    } catch (error) {
      status = `Could not open session: ${errorMessage(error)}`;
    }
  }

  async function openRecentSession(recent: RecentSession) {
    status = 'Opening recent session…';
    try {
      const session = await relay.openRecentSession(recent.id, recent.cwd);
      await refreshSessionLists();
      await openSession(session.id);
    } catch (error) {
      status = `Could not open recent session: ${errorMessage(error)}`;
    }
  }

  async function closeSession(id: string) {
    status = 'Closing session…';
    try {
      await relay.releaseSession(id);
      if (sessionId === id) {
        sessionId = null;
        tab = 'sessions';
        activeTurnId = null;
        interactions = [];
        void sessionCache.saveSelectedSession(null);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        socket?.close();
        socket = null;
      }
      await refreshSessionLists();
      status = 'Session closed.';
    } catch (error) {
      status = `Could not close session: ${errorMessage(error)}`;
    }
  }

  async function forgetSession(id: string) {
    try {
      await relay.forgetSession(id);
      if (sessionId === id) {
        socket?.close();
        sessionId = null;
        activeTurnId = null;
        void sessionCache.saveSelectedSession(null);
      }
      await refreshSessionLists();
    } catch (error) {
      status = `Could not forget session: ${errorMessage(error)}`;
    }
  }

  async function copyResumeCommand(command: string) {
    status = (await copyText(command))
      ? 'Resume command copied.'
      : 'Could not copy the resume command.';
  }

  async function sendMessage() {
    if (!sessionId || !message.trim() || activeTurnId || startingTurn) return;
    const prompt = message.trim();
    startingTurn = true;
    try {
      const turn = await relay.startTurn(sessionId, prompt);
      activeTurnId = turn.activeTurnId ?? null;
      messages = appendUserMessage(
        messages,
        `user-${turn.activeTurnId ?? Date.now().toString()}`,
        prompt,
        Date.now(),
      );
      persistMessages(sessionId);
      message = '';
      void sessionCache.saveDraft(sessionId, '');
      status = turnReadiness(activeTurnId);
    } catch (error) {
      status = reportRelayError(error, 'MESSAGE_SEND_FAILED');
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
    const canonicalMessages: ChatMessage[] = history.items
      .filter((item) => (item.kind === 'user' || item.kind === 'agent') && item.text)
      .map((item) => ({
        id: item.id,
        role: item.kind === 'user' ? 'user' : 'assistant',
        text: item.text!,
        ...(typeof item.occurredAt === 'number' ? { occurredAt: item.occurredAt } : {}),
        ...(item.phase === 'commentary' || item.phase === 'final_answer'
          ? { phase: item.phase }
          : {}),
        complete: true,
      }));
    const unfinishedMessages = messages.filter((message) => !message.complete);
    messages = [...canonicalMessages, ...unfinishedMessages];
    persistMessages(id);
    const canonicalActivities = history.items.flatMap((item) => {
      const activity = toActivity(item);
      return activity ? [activity] : [];
    });
    activities = [
      ...canonicalActivities,
      ...activities.filter(
        (activity) => !canonicalActivities.some((canonical) => canonical.id === activity.id),
      ),
    ];
    if ('activeTurnId' in history) {
      activeTurnId = history.activeTurnId ?? null;
      sessions = sessions.map((session) =>
        session.id === id ? { ...session, activeTurnId } : session,
      );
    }
    cursor = Math.max(cursor, history.currentSequence ?? fallbackSequence);
    void sessionCache.saveCursor(id, cursor);
    status = turnReadiness(activeTurnId);
  }

  function reconcileVisibleHistory(): void {
    if (
      tab !== 'chat' ||
      !sessionId ||
      document.visibilityState !== 'visible' ||
      historyRefreshInFlight
    )
      return;
    historyRefreshInFlight = true;
    void resyncHistory(sessionId)
      .catch(() => undefined)
      .finally(() => {
        historyRefreshInFlight = false;
      });
  }

  function selectTab(next: Tab): void {
    if (next === 'chat' && !chatEnabled) return;
    tab = next;
    if (next === 'chat') {
      reconcileVisibleHistory();
      scrollChatToBottom();
    }
    if (next === 'git' && gitWorkspaceId) void loadGitSummary(gitWorkspaceId);
    if (next === 'sessions') void refreshSessionLists();
  }

  function scrollChatToBottom(): void {
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  }

  async function loadGitSummary(workspaceId = gitWorkspaceId) {
    const selected = workspaceId ? findTreeNode(workspaceTree, workspaceId) : undefined;
    if (!workspaceId || !selected?.isGitRepository) {
      gitSummaryRequest += 1;
      gitSummary = null;
      return;
    }
    const request = ++gitSummaryRequest;
    try {
      const summary = await relay.getGitSummary(workspaceId);
      if (request === gitSummaryRequest && gitWorkspaceId === workspaceId) gitSummary = summary;
    } catch (error) {
      if (request !== gitSummaryRequest || gitWorkspaceId !== workspaceId) return;
      gitSummary = null;
      gitError = reportRelayError(error, 'GIT_SUMMARY_FAILED');
    }
  }

  function selectGitWorkspace(node: WorkspaceOption): void {
    gitWorkspaceId = node.id;
    gitError = null;
    gitSummary = null;
    pushConfirmationOpen = false;
    if (node.isGitRepository) void loadGitSummary(node.id);
    else {
      gitSummaryRequest += 1;
      gitSummary = null;
    }
  }

  async function pullGit() {
    const workspaceId = gitWorkspaceId;
    if (!workspaceId || !findTreeNode(workspaceTree, workspaceId)?.isGitRepository) return;
    refreshRequestKey ??= createIdempotencyKey();
    gitRefreshing = true;
    gitError = null;
    try {
      await relay.pullGit(workspaceId, refreshRequestKey);
      await loadGitSummary(workspaceId);
      refreshRequestKey = null;
    } catch (error) {
      gitError = reportRelayError(error, 'GIT_PULL_FAILED');
    } finally {
      gitRefreshing = false;
    }
  }

  async function cloneGitRepository(address: string) {
    if (gitCloning) return;
    const destination = gitWorkspaceId ? findTreeNode(workspaceTree, gitWorkspaceId) : undefined;
    if (!destination || destination.isGitRepository) {
      gitCloneStatus = null;
      toastQueue.enqueue({
        kind: 'error',
        code: 'INVALID_CLONE_DESTINATION',
        message: 'Select a non-repository folder before cloning.',
      });
      return;
    }
    const workspaceId = destination.id;
    gitCloning = true;
    gitError = null;
    gitCloneStatus = null;
    try {
      await relay.cloneGitRepository(workspaceId, address);
      const bootstrap = await loadBootstrap();
      const postClone = selectAfterClone(
        workspaceTree,
        bootstrap.workspaces,
        workspaceId,
        address,
        gitExpandedIds,
      );
      sessionWorkspaceId =
        refreshSelection(
          sessionWorkspaceId || null,
          workspaceTree,
          bootstrap.workspaces,
          treeNodePolicies.sessionBase,
        ) ?? '';
      workspaceTree = bootstrap.workspaces;
      gitWorkspaceId = postClone.selectedId;
      gitExpandedIds = postClone.expandedIds;
      if (gitWorkspaceId && findTreeNode(workspaceTree, gitWorkspaceId)?.isGitRepository)
        await loadGitSummary(gitWorkspaceId);
      else gitSummary = null;
      gitCloneStatus = 'Repository cloned into the selected workspace.';
      toastQueue.enqueue({ kind: 'success', message: 'Repository cloned.' });
    } catch (error) {
      reportRelayError(error, 'GIT_CLONE_FAILED');
    } finally {
      gitCloning = false;
    }
  }

  async function checkoutGitBranch(branch: string) {
    const workspaceId = gitWorkspaceId;
    if (!workspaceId || branch === gitSummary?.branch) return;
    gitCheckingOut = true;
    gitError = null;
    try {
      await relay.checkoutGitBranch(workspaceId, branch);
      await loadGitSummary(workspaceId);
    } catch (error) {
      gitError = reportRelayError(error, 'GIT_CHECKOUT_FAILED');
    } finally {
      gitCheckingOut = false;
    }
  }

  async function pushGit() {
    const workspaceId = gitWorkspaceId;
    if (!workspaceId) return;
    pushRequestKey ??= createIdempotencyKey();
    gitError = null;
    try {
      await relay.pushGit(workspaceId, pushRequestKey);
      pushConfirmationOpen = false;
      await loadGitSummary(workspaceId);
      pushRequestKey = null;
    } catch (error) {
      gitError = reportRelayError(error, 'GIT_PUSH_FAILED');
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

  function reportRelayError(error: unknown, fallbackCode: RelayFeedbackCode): string {
    const feedback = relayFeedback(error, fallbackCode);
    toastQueue.enqueue({ kind: 'error', ...feedback });
    return feedback.message;
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
    socket = new WebSocket(
      `${protocol}//${location.host}/api/sessions/${encodeURIComponent(id)}/events?after=${cursor}`,
    );
    socket.onopen = () => {
      if (generation !== socketGeneration || sessionId !== id) return;
      status = turnReadiness(activeTurnId);
      reconcileVisibleHistory();
      stableConnectionTimer = setTimeout(() => {
        reconnectAttempt = 0;
      }, 30_000);
    };
    socket.onmessage = (message) => {
      const envelope = JSON.parse(String(message.data));
      if (envelope.type === 'relay.resyncRequired') {
        void resyncHistory(
          id,
          typeof envelope.currentSequence === 'number' ? envelope.currentSequence : 0,
        );
        return;
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'interaction.requested') {
        const interaction = envelope.event.payload as {
          requestId: string;
          kind: string;
          payload: unknown;
        };
        if (!interactions.some((item) => item.requestId === interaction.requestId))
          interactions = [...interactions, interaction];
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'turnCompleted') {
        activeTurnId = null;
        status = turnReadiness(activeTurnId);
        messages = completeMessage(messages, `assistant-${id}`);
        persistMessages(id);
        void resyncHistory(id).catch(() => undefined);
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'session.updated') {
        const updated = envelope.event.payload;
        if (
          typeof updated === 'object' &&
          updated !== null &&
          (updated as { id?: unknown }).id === id
        ) {
          const session = updated as RelaySession;
          const previousTurnId = activeTurnId;
          activeTurnId = typeof session.activeTurnId === 'string' ? session.activeTurnId : null;
          if (previousTurnId && !activeTurnId) status = turnReadiness(activeTurnId);
          sessions = sessions.map((item) => (item.id === id ? { ...item, ...session } : item));
        }
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'interaction.resolved') {
        const { requestId } = envelope.event.payload as { requestId: string };
        interactions = interactions.filter((interaction) => interaction.requestId !== requestId);
      }
      if (envelope.type === 'relay.event' && envelope.event?.type === 'activity.updated') {
        const activity = envelope.event.payload as HistoryActivity;
        if (
          typeof activity.id === 'string' &&
          typeof activity.label === 'string' &&
          typeof activity.detail === 'string'
        )
          activities = [...activities.filter((item) => item.id !== activity.id), activity];
      }
      cursor = applyRelayEvent(
        cursor,
        envelope,
        (text) => {
          messages = applyDelta(messages, `assistant-${id}`, text, Date.now());
          persistMessages(id);
        },
        () => {
          void resyncHistory(id);
        },
      );
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
  <title>Gestalt Mobile</title>
</svelte:head>

{#if toastEvidence === 'error' || toastEvidence === 'stacked'}
  <ToastEvidence variant={toastEvidence} />
{:else if evidenceContext === 'sessions' || evidenceContext === 'git'}
  <main class="evidence-mode">
    <FilesystemTreeEvidence context={evidenceContext} />
  </main>
{:else}
  <main>
    <AppHeader
      {theme}
      sessionPath={tab === 'chat'
        ? displayWorkspacePath(
            sessions.find((session) => session.id === sessionId)?.workspacePath ?? '',
          )
        : null}
      onthemechange={setTheme}
    />

    {#if tab === 'chat'}
      <section aria-labelledby="chat-title">
        <h2 id="chat-title" class="visually-hidden">Chat</h2>
        {#if sessionId}
          <MessageList {messages} />
          <ActivityList {activities} />
          <InteractionList
            {interactions}
            answers={userInputAnswers}
            onanswer={setUserInputAnswer}
            onuserinput={(interaction) => void resolveUserInput(interaction)}
            onpermission={(interaction) => void resolvePermissions(interaction)}
            ondecision={(id, decision) => void resolveInteraction(id, decision)}
          />
          <Composer
            {status}
            {message}
            {activeTurnId}
            starting={startingTurn}
            onchange={updateDraft}
            onsend={() => void sendMessage()}
            oninterrupt={() => void interruptTurn()}
          />
        {:else}
          <p>Start a session from the Sessions tab to chat with Codex.</p>
        {/if}
      </section>
    {:else if tab === 'git'}
      <GitView
        {workspaceTree}
        selectedWorkspace={gitWorkspaceId
          ? (findTreeNode(workspaceTree, gitWorkspaceId) ?? null)
          : null}
        expandedIds={gitExpandedIds}
        summary={gitSummary}
        refreshing={gitRefreshing}
        checkingOut={gitCheckingOut}
        cloning={gitCloning}
        error={gitError}
        cloneStatus={gitCloneStatus}
        confirmingPush={pushConfirmationOpen}
        onpull={() => void pullGit()}
        oncheckout={(branch) => void checkoutGitBranch(branch)}
        onopenpushconfirmation={() => (pushConfirmationOpen = true)}
        onpush={() => void pushGit()}
        oncancelpush={() => (pushConfirmationOpen = false)}
        onselect={selectGitWorkspace}
        onexpandedchange={(value) => (gitExpandedIds = value)}
        onclone={(address) => void cloneGitRepository(address)}
      />
    {:else}
      <SessionsView
        {sessions}
        {recentSessions}
        {workspaceTree}
        workspaceId={sessionWorkspaceId}
        expandedIds={sessionExpandedIds}
        {sandbox}
        {approvalPolicy}
        {startingSession}
        onworkspacechange={(value) => (sessionWorkspaceId = value)}
        onexpandedchange={(value) => (sessionExpandedIds = value)}
        onsandboxchange={(value) => (sandbox = value)}
        onapprovalpolicychange={(value) => (approvalPolicy = value)}
        onopen={openSession}
        onclose={(id) => void closeSession(id)}
        onopenrecent={(session) => void openRecentSession(session)}
        onforget={(id) => void forgetSession(id)}
        oncopyresume={(command) => void copyResumeCommand(command)}
        onstart={() => void startSession()}
      />
    {/if}

    <BottomNavigation activeTab={tab} {chatEnabled} onselect={selectTab} />
  </main>
{/if}
{#if toastEvidence !== 'error' && toastEvidence !== 'stacked'}
  <ToastViewport queue={toastQueue} />
{/if}

<style>
  .evidence-mode {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 0;
  }
</style>
