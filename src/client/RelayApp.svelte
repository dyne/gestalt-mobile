<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { selectTheme } from './features/theme/browser-theme.js';
  import { type ThemeId } from './features/theme/theme-registry.js';

  let {
    authorizedFetch,
    passkeyAuthEnabled,
    theme: initialTheme,
    onlock,
    oncreatepasskey = () => {},
  }: {
    authorizedFetch: typeof fetch;
    passkeyAuthEnabled: boolean;
    theme: ThemeId;
    onlock: () => void;
    oncreatepasskey?: (ticket: string) => void;
  } = $props();

  import AppHeader from './components/AppHeader.svelte';
  import ActivityList from './features/chat/ActivityList.svelte';
  import InteractionList from './features/chat/InteractionList.svelte';
  import Composer from './features/chat/Composer.svelte';
  import MessageList from './features/chat/MessageList.svelte';
  import { loadBootstrap, type WorkspaceOption } from './features/catalog/bootstrap-client.js';
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
  import { GitController, type GitState } from './features/git/git-controller.js';
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
    mapNativeUserInputToQuiz,
    parseQuiz,
    toQuizToolResponse,
  } from '../shared/contracts/quiz.js';
  import {
    createRelayClient,
    type RelayGitSummary,
    type RelayHistory,
    type RecentSession,
    type RelaySession,
    type RelaySkillProfile,
    type StartSessionSettings,
    type WorkspacePlanEntry,
  } from './features/sessions/relay-client.js';
  import { copyText } from './features/sessions/clipboard.js';
  import { createIdempotencyKey } from './features/sessions/idempotency-key.js';
  import { applyRelayEvent } from './features/sessions/session-events-client.js';
  import { createPlanController, type PlanState } from './features/plans/plan-controller.js';
  import { isRelayPlanUpdate } from './features/plans/contracts.js';
  import { weeklyQuotaRemaining } from './features/plans/weekly-quota.js';
  import PlansView, { type PlansCatalogState } from './features/plans/PlansView.svelte';
  import { turnReadiness } from './features/sessions/session-state.js';
  import { SessionConnectionController } from './features/sessions/session-connection-controller.js';
  import { createSessionCache } from './features/sessions/session-cache.js';
  import { getHistoryWithRecovery } from './features/sessions/history-recovery.js';
  import SessionsView from './features/sessions/SessionsView.svelte';
  import { validateStartForm } from './features/sessions/start-form.js';
  import {
    SessionStartController,
    type SessionStartState,
  } from './features/sessions/session-start-controller.js';
  import { nextTab, type Tab } from './features/sessions/tab-state.js';
  import BottomNavigation from './features/sessions/BottomNavigation.svelte';
  import {
    displayWorkspacePath,
    retainForgottenSession,
  } from './features/sessions/session-list.js';
  import SkillsView from './features/skills/SkillsView.svelte';
  import { SkillsState } from './features/skills/skills-state.js';
  import AuthorizedDevicesView from './features/auth/AuthorizedDevicesView.svelte';
  import { createDeviceClient } from './features/auth/device-client.js';
  import Scratchpad from './features/scratchpad/Scratchpad.svelte';

  let tab = $state<Tab>('sessions');
  let devicesOpen = $state(false);
  let scratchpadOpen = $state(false);
  let status = $state('Loading relay…');
  let theme = $state<ThemeId>(untrack(() => initialTheme));
  let workspaceTree = $state<WorkspaceOption[]>([]);
  const defaultSessionModel = 'gpt-5.6-terra';
  let sessionModels = $state.raw<string[]>([defaultSessionModel]);
  let sessionModel = $state(defaultSessionModel);
  let codexProfiles = $state.raw<Array<{ name: string; state: string; status: string }>>([]);
  let skillsState = $state<SkillsState | null>(null);
  let skillsLoaded = false;
  let sessionSubview = $state<'list' | 'profile-manager'>('list');
  let sessionSkillProfiles = $state.raw<RelaySkillProfile[]>([]);
  let selectedSessionSkillProfile = $state('');
  let sessionSkillProfileError = $state('');
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
  let sandbox = $state<NonNullable<StartSessionSettings['sandbox']>>('workspace-write');
  let approvalPolicy = $state<NonNullable<StartSessionSettings['approvalPolicy']>>('on-request');
  let startRequestKey = $state<string | null>(null);
  let sessionStartState = $state<SessionStartState>({ starting: false, error: null });
  let startingSession = $derived(sessionStartState.starting);
  let openingSessionId = $state<string | null>(null);
  let recoveryNotice = $state<string | null>(null);
  let message = $state('');
  let activeTurnId = $state<string | null>(null);
  let startingTurn = $state(false);
  let messages = $state<ChatMessage[]>([]);
  let activities = $state<HistoryActivity[]>([]);
  let cursor = $state(0);
  let planState = $state<PlanState>({ kind: 'unavailable', sessionId: null });
  let plansCatalog = $state.raw<PlansCatalogState>({ kind: 'no-workspace' });
  let passivePlan = $state.raw<import('./features/plans/contracts.js').SupervisedPlan | null>(null);
  let hideLivePlan = $state(false);
  let plansCatalogRequest: AbortController | null = null;
  let passivePlanRequest: AbortController | null = null;
  let plansCatalogGeneration = 0;
  let passivePlanGeneration = 0;
  let navigationFocus = $state<Tab | null>(null);
  let lastPlanOpenSignal = $state('');
  let plansWorkspaceId = $derived(
    (sessions.find((session) => session.id === sessionId)?.workspaceId ?? sessionWorkspaceId) ||
      null,
  );
  let visiblePlanState = $derived.by<PlanState | null>(() => {
    if (passivePlan) return { kind: 'ready', sessionId: 'catalog', plan: passivePlan };
    if (hideLivePlan) return null;
    if (planState.kind === 'ready' || planState.kind === 'closing') return planState;
    if (planState.kind === 'error' && planState.plan) return planState;
    return null;
  });
  let weeklyQuotaRemainingValue = $derived(
    weeklyQuotaRemaining(
      planState.kind === 'ready' || planState.kind === 'closing' || planState.kind === 'error'
        ? planState.plan
        : undefined,
    ),
  );
  let gitState = $state<GitState>({
    workspaceId: null,
    summary: null,
    loading: false,
    refreshing: false,
    checkingOut: false,
    error: null,
  });
  let gitWorkspaceId = $derived(gitState.workspaceId);
  let gitExpandedIds = $state<Set<string>>(new Set());
  let pushConfirmationOpen = $state(false);
  let gitCloning = $state(false);
  let gitCloneStatus = $state<string | null>(null);
  let refreshRequestKey = $state<string | null>(null);
  let pushRequestKey = $state<string | null>(null);
  let interactions = $state<Array<{ requestId: string; kind: string; payload: unknown }>>([]);
  let userInputAnswers = $state<Record<string, string>>({});
  const relay = createRelayClient((input, init) => authorizedFetch(input, init));
  const sessionStartController = new SessionStartController(
    { start: relay.startSession },
    createIdempotencyKey,
    (next) => (sessionStartState = next),
  );
  const gitController = new GitController(
    { getSummary: relay.getGitSummary, pull: relay.pullGit, checkout: relay.checkoutGitBranch },
    (workspaceId) => Boolean(findTreeNode(workspaceTree, workspaceId)?.isGitRepository),
    (next) => (gitState = next),
    (error, code) => reportRelayError(error, code),
  );
  const connection = new SessionConnectionController({
    selectedSessionId: () => sessionId,
    cursor: () => cursor,
    onopen: () => (status = turnReadiness(activeTurnId)),
    onclose: () => (status = 'Connection interrupted. Reconnecting…'),
    onmessage: (raw) => handleSessionSocketMessage(raw),
    onreconcile: async () => {
      if (sessionId) await resyncHistory(sessionId);
    },
  });
  const deviceClient = createDeviceClient((input, init) => authorizedFetch(input, init));
  const planController = createPlanController(
    { getPlan: relay.getPlan, closePlan: relay.closePlan },
    (next) => (planState = next),
  );
  const messageCache = createMessageCache();
  const sessionCache = createSessionCache();
  const toastQueue = createToastQueue();
  const evidenceContext = new URLSearchParams(location.search).get('tree-evidence');
  const toastEvidence = new URLSearchParams(location.search).get('toast-evidence');

  function openScratchpad(): void {
    scratchpadOpen = true;
  }

  function closeScratchpad(): void {
    scratchpadOpen = false;
    void tick().then(() => document.querySelector<HTMLButtonElement>('.menu-trigger')?.focus());
  }

  onMount(async () => {
    if (
      evidenceContext === 'sessions' ||
      evidenceContext === 'git' ||
      toastEvidence === 'error' ||
      toastEvidence === 'stacked'
    )
      return;
    connection.start();
    try {
      const bootstrap = await loadBootstrap(authorizedFetch);
      sessionWorkspaceId =
        refreshSelection(
          sessionWorkspaceId || null,
          workspaceTree,
          bootstrap.workspaces,
          treeNodePolicies.sessionBase,
        ) ?? '';
      workspaceTree = bootstrap.workspaces;
      codexProfiles = bootstrap.profiles;
      sessionModels = [...new Set([defaultSessionModel, ...(bootstrap.models ?? [])])];
      await refreshSkillProfiles();
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
      planController.select(sessionId);
      if (sessionId) {
        await resyncHistory(sessionId);
        connectSession(sessionId);
      }
    } catch (error) {
      status = reportRelayError(error, 'RELAY_UNAVAILABLE');
    }
  });

  function setTheme(value: ThemeId): void {
    theme = selectTheme(value);
  }

  onDestroy(() => {
    connection.dispose();
    planController.dispose();
    gitController.dispose();
    sessionStartController.dispose();
    skillsState?.dispose();
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
    status = 'Starting session…';
    const session = await sessionStartController.start(sessionWorkspaceId, {
      sandbox,
      approvalPolicy,
      model: sessionModel,
      skillProfile: selectedSessionSkillProfile || undefined,
    });
    if (!session) {
      if (sessionStartState.error)
        status = reportRelayError(new Error(sessionStartState.error), 'SESSION_START_FAILED');
      return;
    }
    try {
      sessionId = session.id;
      planController.select(session.id);
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
      scrollTabIntoInitialPosition('chat');
      status = 'Session started.';
    } catch (error) {
      status = reportRelayError(error, 'SESSION_START_FAILED');
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
    openingSessionId = id;
    try {
      const existing = sessions.find((session) => session.id === id);
      if (existing && existing.state !== 'ready' && existing.state !== 'turnActive') {
        const restored = await relay.restoreSession(id);
        sessions = sessions.map((session) => (session.id === id ? restored : session));
        if (restored.recovery?.replacementCreated) {
          recoveryNotice =
            'Open created a replacement session because the prior Codex history was unavailable.';
        }
      }
      sessionId = id;
      planController.select(id);
      void sessionCache.saveSelectedSession(id);
      messages = await messageCache.read(id);
      activities = [];
      cursor = 0;
      message = await sessionCache.readDraft(id);
      activeTurnId = sessions.find((session) => session.id === id)?.activeTurnId ?? null;
      interactions = sessions.find((session) => session.id === id)?.pendingInteractions ?? [];
      tab = 'chat';
      scrollTabIntoInitialPosition('chat');
      await resyncHistory(id);
      connectSession(id);
    } catch (error) {
      status = `Could not open session: ${errorMessage(error)}`;
    } finally {
      openingSessionId = null;
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
        connection.disconnect();
      }
      await refreshSessionLists();
      status = 'Session closed.';
    } catch (error) {
      status = `Could not close session: ${errorMessage(error)}`;
    }
  }

  async function forgetSession(id: string) {
    const forgottenSession = sessions.find((session) => session.id === id);
    try {
      await relay.forgetSession(id);
      if (sessionId === id) {
        connection.disconnect();
        sessionId = null;
        activeTurnId = null;
        void sessionCache.saveSelectedSession(null);
      }
      await refreshSessionLists();
      recentSessions = retainForgottenSession(recentSessions, forgottenSession);
    } catch (error) {
      status = `Could not forget session: ${errorMessage(error)}`;
    }
  }

  async function copyResumeCommand(command: string) {
    status = (await copyText(command))
      ? 'Resume command copied.'
      : 'Could not copy the resume command.';
  }

  async function selectSessionModel(model: string): Promise<void> {
    if (!sessionId || activeTurnId) return;
    try {
      const updated = await relay.selectModel(sessionId, model);
      sessions = sessions.map((session) =>
        session.id === updated.id ? { ...session, ...updated } : session,
      );
      message = '';
      status = `Model changed to ${model}; it applies to the next turn.`;
    } catch (error) {
      status = `Could not change model: ${errorMessage(error)}`;
    }
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
    const { history, restored } = await getHistoryWithRecovery(relay, id);
    if (restored) {
      sessions = sessions.map((session) => (session.id === id ? restored : session));
      if (restored.recovery?.replacementCreated)
        recoveryNotice =
          'The session was restored with a replacement Codex thread because its prior history was unavailable.';
    }
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
    if (fallbackSequence) planController.refresh(id);
    status = turnReadiness(activeTurnId);
  }

  function reconcileVisibleHistory(): void {
    if (tab === 'chat' && sessionId) connection.resync();
  }

  function selectTab(next: Tab, focusChatPrompt = false): void {
    if (next === 'chat' && !chatEnabled) return;
    const changedTab = tab !== next;
    tab = next;
    scrollTabIntoInitialPosition(next);
    if (next === 'chat') {
      reconcileVisibleHistory();
      if (changedTab && focusChatPrompt) focusChatPromptOnDesktop();
    }
    if (next === 'git' && gitWorkspaceId) void gitController.refresh();
    if (next === 'sessions') {
      if (sessionSubview === 'profile-manager') void closeProfileManager(false);
      void refreshSessionLists();
    }
  }

  $effect(() => {
    const workspaceId = plansWorkspaceId;
    if (tab === 'plan') loadPlansCatalog(workspaceId);
  });

  function focusNavigationTab(next: Tab): void {
    navigationFocus = next;
    queueMicrotask(() => (navigationFocus = null));
  }

  let swipeStart: Readonly<{ pointerId: number; x: number; y: number }> | null = null;

  function isInteractiveTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest('button, input, textarea, select, a, summary, [contenteditable]') !== null
    );
  }

  function beginTabSwipe(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || isInteractiveTarget(event.target)) return;
    swipeStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function completeTabSwipe(event: PointerEvent): void {
    if (!swipeStart || event.pointerId !== swipeStart.pointerId) return;
    const start = swipeStart;
    swipeStart = null;
    const horizontal = event.clientX - start.x;
    const vertical = event.clientY - start.y;
    if (Math.abs(horizontal) < 48 || Math.abs(horizontal) <= Math.abs(vertical)) return;
    selectTab(nextTab(tab, horizontal < 0 ? 1 : -1, { chatEnabled }));
  }

  function cancelTabSwipe(event: PointerEvent): void {
    if (swipeStart?.pointerId === event.pointerId) swipeStart = null;
  }

  function loadPlansCatalog(workspaceId = plansWorkspaceId): void {
    plansCatalogRequest?.abort();
    passivePlanRequest?.abort();
    passivePlan = null;
    if (!workspaceId) {
      plansCatalog = { kind: 'no-workspace' };
      return;
    }
    const request = new AbortController();
    plansCatalogRequest = request;
    const generation = ++plansCatalogGeneration;
    plansCatalog = { kind: 'loading', workspaceId };
    void relay
      .listWorkspacePlans(workspaceId, request.signal)
      .then((entries) => {
        if (generation !== plansCatalogGeneration || request.signal.aborted) return;
        plansCatalog = { kind: 'ready', workspaceId, entries };
      })
      .catch((error: unknown) => {
        if (generation !== plansCatalogGeneration || request.signal.aborted) return;
        plansCatalog = {
          kind: 'error',
          workspaceId,
          error: error instanceof Error ? error.message : 'Could not load workspace plans.',
        };
      });
  }

  function openWorkspacePlan(planName: string): void {
    const workspaceId = plansWorkspaceId;
    if (!workspaceId) return;
    passivePlanRequest?.abort();
    const request = new AbortController();
    passivePlanRequest = request;
    const generation = ++passivePlanGeneration;
    void relay
      .getWorkspacePlan(workspaceId, planName, request.signal)
      .then((plan) => {
        if (generation !== passivePlanGeneration || request.signal.aborted) return;
        passivePlan = plan;
        hideLivePlan = false;
      })
      .catch((error: unknown) => {
        if (generation !== passivePlanGeneration || request.signal.aborted) return;
        plansCatalog = {
          kind: 'error',
          workspaceId,
          error: error instanceof Error ? error.message : 'Could not open this plan.',
        };
      });
  }

  function closePlanViewer(): void {
    passivePlan = null;
    hideLivePlan = true;
    loadPlansCatalog();
  }

  async function loadSkills(workspaceId: string, profile: string): Promise<void> {
    const next = new SkillsState(relay);
    await next.load(workspaceId, profile);
    skillsState = next;
    skillsLoaded = true;
  }

  async function refreshSkillProfiles(): Promise<void> {
    try {
      const profiles = await relay.listSkillProfiles();
      sessionSkillProfiles = profiles.profiles.filter(
        (profile): profile is RelaySkillProfile => !('error' in profile),
      );
      const invalid = profiles.profiles.find((profile) => 'error' in profile);
      sessionSkillProfileError = invalid && 'error' in invalid ? invalid.error.message : '';
      if (!sessionSkillProfiles.some((profile) => profile.name === selectedSessionSkillProfile))
        selectedSessionSkillProfile = '';
    } catch (error) {
      sessionSkillProfiles = [];
      sessionSkillProfileError =
        error instanceof Error ? error.message : 'Unable to load saved skill profiles.';
    }
  }

  async function openProfileManager(_trigger: HTMLButtonElement): Promise<void> {
    const workspaceId = sessionWorkspaceId || workspaceTree[0]?.id || '';
    const profile = codexProfiles.find((item) => item.state === 'ok')?.name ?? '';
    if (!workspaceId || !profile) {
      status = 'Choose a workspace and available Codex profile before managing skill profiles.';
      return;
    }
    await loadSkills(workspaceId, profile);
    sessionSubview = 'profile-manager';
  }

  function focusOnAttach(element: HTMLElement): void {
    queueMicrotask(() => element.focus());
  }

  async function closeProfileManager(returnFocus = true): Promise<void> {
    sessionSubview = 'list';
    await tick();
    if (returnFocus) document.getElementById('manage-skill-profiles')?.focus();
  }

  function scrollTabIntoInitialPosition(target: Tab): void {
    requestAnimationFrame(() => {
      if (tab !== target) return;
      window.scrollTo({ top: target === 'chat' ? document.documentElement.scrollHeight : 0 });
    });
  }

  let chatScrollPending = false;

  function scrollChatToBottom(): void {
    if (chatScrollPending) return;
    chatScrollPending = true;
    requestAnimationFrame(() => {
      chatScrollPending = false;
      if (tab === 'chat') window.scrollTo({ top: document.documentElement.scrollHeight });
    });
  }

  function focusChatPromptOnDesktop(): void {
    if (!window.matchMedia('(min-width: 48rem)').matches) return;
    void tick().then(() => {
      if (tab === 'chat') document.getElementById('message')?.focus();
    });
  }

  function selectGitWorkspace(node: WorkspaceOption): void {
    gitController.select(node.id);
    pushConfirmationOpen = false;
  }

  async function pullGit() {
    const workspaceId = gitWorkspaceId;
    if (!workspaceId || !findTreeNode(workspaceTree, workspaceId)?.isGitRepository) return;
    refreshRequestKey ??= createIdempotencyKey();
    await gitController.pull(refreshRequestKey);
    if (!gitState.error) refreshRequestKey = null;
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
    gitCloneStatus = null;
    try {
      await relay.cloneGitRepository(workspaceId, address);
      const bootstrap = await loadBootstrap(authorizedFetch);
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
      gitController.select(postClone.selectedId);
      gitExpandedIds = postClone.expandedIds;
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
    if (!workspaceId) return;
    await gitController.checkout(branch);
  }

  async function pushGit() {
    const workspaceId = gitWorkspaceId;
    if (!workspaceId) return;
    pushRequestKey ??= createIdempotencyKey();
    try {
      await relay.pushGit(workspaceId, pushRequestKey);
      pushConfirmationOpen = false;
      await gitController.refresh();
      pushRequestKey = null;
    } catch (error) {
      reportRelayError(error, 'GIT_PUSH_FAILED');
    }
  }

  async function resolveInteraction(requestId: string, decision: 'accept' | 'decline') {
    if (!sessionId) return;
    await relay.respondInteraction(sessionId, requestId, { decision });
    interactions = interactions.filter((interaction) => interaction.requestId !== requestId);
  }

  async function resolveUserInput(interaction: {
    requestId: string;
    kind: string;
    payload: unknown;
  }) {
    if (!sessionId) return;
    const quiz =
      interaction.kind === 'quiz'
        ? parseQuiz(interaction.payload)
        : mapNativeUserInputToQuiz(interaction.payload);
    if (!quiz) return;
    const answers = quiz.questions.map((question) => ({
      id: question.id,
      answer: userInputAnswers[`${interaction.requestId}:${question.id}`] ?? '',
    }));
    const response =
      interaction.kind === 'quiz' ? toQuizToolResponse(answers) : toUserInputResponse(answers);
    try {
      await relay.respondInteraction(sessionId, interaction.requestId, response);
      interactions = interactions.filter((item) => item.requestId !== interaction.requestId);
    } catch {
      status = 'Could not send quiz answers. Please try again.';
    }
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

  function setUserInputAnswer(requestId: string, questionId: string, answer: string) {
    userInputAnswers[`${requestId}:${questionId}`] = answer;
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
    connection.connect(id);
  }

  function handleSessionSocketMessage(raw: string) {
    if (!sessionId) return;
    const id = sessionId;
    const envelope = JSON.parse(raw);
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
      (event) => {
        planController.applyEvent(id, event);
        if (event.type !== 'plan.updated' || !isRelayPlanUpdate(event.payload)) return;
        if (
          event.payload.reason !== 'authoring-start' &&
          event.payload.reason !== 'work-start' &&
          event.payload.reason !== 'supervision-start' &&
          event.payload.reason !== 'resync'
        )
          return;
        const signal = `${id}:${event.sequence}`;
        if (signal === lastPlanOpenSignal) return;
        lastPlanOpenSignal = signal;
        tab = 'plan';
        scrollTabIntoInitialPosition('plan');
      },
    );
    void sessionCache.saveCursor(id, cursor);
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
  <main
    class="swipe-surface"
    onpointerdown={beginTabSwipe}
    onpointerup={completeTabSwipe}
    onpointercancel={cancelTabSwipe}
  >
    {#if !devicesOpen}<AppHeader
        {theme}
        sessionPath={tab === 'chat'
          ? displayWorkspacePath(
              sessions.find((session) => session.id === sessionId)?.workspacePath ?? '',
            )
          : null}
        sessionModel={tab === 'chat'
          ? (sessions.find((session) => session.id === sessionId)?.model ?? defaultSessionModel)
          : null}
        weeklyQuotaRemaining={weeklyQuotaRemainingValue}
        {passkeyAuthEnabled}
        {onlock}
        ondevices={() => (devicesOpen = true)}
        onscratchpad={openScratchpad}
        onthemechange={setTheme}
      />{/if}
    {#if devicesOpen && passkeyAuthEnabled}
      <AuthorizedDevicesView
        client={deviceClient}
        onclose={() => {
          devicesOpen = false;
          void tick().then(() =>
            document.querySelector<HTMLButtonElement>('.menu-trigger')?.focus(),
          );
        }}
        {onlock}
        oncreatepasskey={(ticket) => oncreatepasskey(ticket)}
      />
    {:else}
      {#if recoveryNotice}
        <div class="recovery-notice" role="status" aria-live="polite" aria-atomic="true">
          <span>{recoveryNotice}</span>
          <button type="button" onclick={() => (recoveryNotice = null)}>Dismiss</button>
        </div>
      {/if}

      {#if tab === 'chat'}
        <section class="chat-view" aria-labelledby="chat-title">
          <h2 id="chat-title" class="visually-hidden">Chat</h2>
          {#if sessionId}
            <MessageList {messages} {activities} />
            <InteractionList
              {interactions}
              answers={userInputAnswers}
              onanswer={setUserInputAnswer}
              onquiz={(interaction) => void resolveUserInput(interaction)}
              onpermission={(interaction) => void resolvePermissions(interaction)}
              ondecision={(id, decision) => void resolveInteraction(id, decision)}
            />
            <Composer
              {status}
              {message}
              {activeTurnId}
              starting={startingTurn}
              models={sessionModels}
              onchange={updateDraft}
              onscrollbottom={scrollChatToBottom}
              onmodelselect={(model) => void selectSessionModel(model)}
              onsend={() => void sendMessage()}
              oninterrupt={() => void interruptTurn()}
            />
          {:else}
            <p>Start a session from the Sessions tab to chat with Codex.</p>
          {/if}
        </section>
      {:else if tab === 'plan'}
        <PlansView
          catalog={plansCatalog}
          state={visiblePlanState}
          onopen={openWorkspacePlan}
          onclose={closePlanViewer}
        />
      {:else if tab === 'git'}
        <GitView
          {workspaceTree}
          selectedWorkspace={gitWorkspaceId
            ? (findTreeNode(workspaceTree, gitWorkspaceId) ?? null)
            : null}
          expandedIds={gitExpandedIds}
          summary={gitState.summary}
          refreshing={gitState.refreshing}
          checkingOut={gitState.checkingOut}
          cloning={gitCloning}
          error={gitState.error}
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
        {#if sessionSubview === 'profile-manager'}
          <section class="session-profile-manager" aria-labelledby="session-profile-manager-title">
            <div class="session-profile-manager-header">
              <h2 id="session-profile-manager-title" tabindex="-1" {@attach focusOnAttach}>
                Manage skill profiles
              </h2>
              <button
                type="button"
                class="close-profile-manager"
                aria-label="Close skill profile editor"
                onclick={() => void closeProfileManager()}>×</button
              >
            </div>
            {#if skillsState}
              <SkillsView
                {skillsState}
                onrefresh={() => skillsState?.refresh() ?? Promise.resolve()}
                onprofileschange={() => void refreshSkillProfiles()}
                heading="Skill profile editor"
              />
            {:else}
              <p>Loading skill profiles…</p>
            {/if}
          </section>
        {:else}
          <SessionsView
            {sessions}
            {recentSessions}
            selectedSessionId={sessionId}
            {workspaceTree}
            workspaceId={sessionWorkspaceId}
            expandedIds={sessionExpandedIds}
            {sandbox}
            {approvalPolicy}
            models={sessionModels}
            selectedModel={sessionModel}
            skillProfiles={sessionSkillProfiles}
            selectedSkillProfile={selectedSessionSkillProfile}
            skillProfileError={sessionSkillProfileError}
            {startingSession}
            {openingSessionId}
            onworkspacechange={(value) => (sessionWorkspaceId = value)}
            onexpandedchange={(value) => (sessionExpandedIds = value)}
            onsandboxchange={(value) => (sandbox = value)}
            onapprovalpolicychange={(value) => (approvalPolicy = value)}
            onmodelchange={(value) => (sessionModel = value)}
            onskillprofilechange={(value) => (selectedSessionSkillProfile = value)}
            onmanageprofiles={(trigger) => void openProfileManager(trigger)}
            onopen={openSession}
            onselectopen={openSession}
            onclose={(id) => void closeSession(id)}
            onopenrecent={(session) => void openRecentSession(session)}
            onforget={(id) => void forgetSession(id)}
            oncopyresume={(command) => void copyResumeCommand(command)}
            onstart={() => void startSession()}
          />
        {/if}
      {/if}

      <BottomNavigation
        activeTab={tab}
        {chatEnabled}
        focusTab={navigationFocus}
        onselect={selectTab}
      />
    {/if}
  </main>
  {#if scratchpadOpen}<Scratchpad onclose={closeScratchpad} />{/if}
{/if}
{#if toastEvidence !== 'error' && toastEvidence !== 'stacked'}
  <ToastViewport queue={toastQueue} />
{/if}

<style>
  .chat-view {
    margin-inline: calc(0.25rem - var(--page-inline-padding));
  }

  .swipe-surface {
    touch-action: pan-y;
  }

  .evidence-mode {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 0;
  }

  .session-profile-manager-header {
    box-sizing: border-box;
    display: flex;
    align-items: safe center;
    justify-content: space-between;
    gap: 1rem;
    inline-size: 100%;
    min-inline-size: 0;
    padding-inline: max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-right));
  }

  .session-profile-manager-header h2 {
    margin: 0;
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .close-profile-manager {
    flex: 0 0 auto;
    inline-size: 2.5rem;
    min-block-size: 2.5rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 2rem;
    line-height: 1;
  }
</style>
