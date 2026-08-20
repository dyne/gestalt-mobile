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
  import AgentActivityIndicators from './features/agent-activity/AgentActivityIndicators.svelte';
  import AgentActivityEvidence from './features/agent-activity/AgentActivityEvidence.svelte';
  import { AgentActivityController } from './features/agent-activity/agent-activity-controller.js';
  import type { AgentActivitySnapshot } from './features/agent-activity/contracts.js';
  import {
    AutopilotController,
    type AutopilotClientState,
  } from './features/autopilot/autopilot-controller.js';
  import AutopilotControl from './features/autopilot/AutopilotControl.svelte';
  import AutopilotAttention from './features/autopilot/AutopilotAttention.svelte';
  import AutopilotSafetyStop from './features/autopilot/AutopilotSafetyStop.svelte';
  import { createAttentionToastDedupe } from './features/autopilot/attention-toast-dedupe.js';
  import Composer from './features/chat/Composer.svelte';
  import MessageList from './features/chat/MessageList.svelte';
  import { loadBootstrap, type WorkspaceOption } from './features/catalog/bootstrap-client.js';
  import { submitsOnEnter } from './features/chat/keyboard.js';
  import { createChatCache } from './features/chat/chat-cache.js';
  import { ChatController, type ChatViewState } from './features/chat/chat-controller.js';
  import { ChatFollowTail } from './features/chat/chat-follow-tail.js';
  import { ChatTailScheduler } from './features/chat/chat-tail-scheduler.js';
  import type { ProjectionEvent } from './features/chat/chat-projection.js';
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
    type RecentSession,
    type RelaySession,
    type RelaySkillProfile,
    type StartSessionSettings,
    type WorkspacePlanEntry,
  } from './features/sessions/relay-client.js';
  import { copyText } from './features/sessions/clipboard.js';
  import { createIdempotencyKey } from './features/sessions/idempotency-key.js';
  import { createPlanController, type PlanState } from './features/plans/plan-controller.js';
  import { isRelayPlanUpdate } from './features/plans/contracts.js';
  import { weeklyQuotaRemaining } from './features/plans/weekly-quota.js';
  import PlansView, { type PlansCatalogState } from './features/plans/PlansView.svelte';
  import { createSessionCache } from './features/sessions/session-cache.js';
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

  let chatView = $state<ChatViewState | null>(null);
  let tab = $state<Tab>('sessions');
  let devicesOpen = $state(false);
  let scratchpadOpen = $state(false);
  let shellStatus = $state('Loading relay…');
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
  let activitySnapshots = $state.raw<ReadonlyMap<string, AgentActivitySnapshot>>(new Map());
  let autopilotState = $state.raw<AutopilotClientState>({
    snapshots: new Map(),
    attention: new Map(),
    pending: new Set(),
    errors: new Map(),
  });
  let sessionListEpoch = 0;
  let sessionListAbort: AbortController | null = null;
  let chatEnabled = $derived(sessions.some((session) => session.id === sessionId));
  let recentSessions = $state<RecentSession[]>([]);
  let sandbox = $state<NonNullable<StartSessionSettings['sandbox']>>('workspace-write');
  let approvalPolicy = $state<NonNullable<StartSessionSettings['approvalPolicy']>>('on-request');
  let startRequestKey = $state<string | null>(null);
  let sessionStartState = $state<SessionStartState>({ starting: false, error: null });
  let startingSession = $derived(sessionStartState.starting);
  let openingSessionId = $state<string | null>(null);
  let openGeneration = 0;
  let writerFeedback = $state<string | null>(null);
  let retryOperationId = $state<string | null>(null);
  let recoveryNotice = $state<string | null>(null);
  let message = $state('');
  let planState = $state<PlanState>({ kind: 'unavailable', sessionId: null });
  let plansCatalog = $state.raw<PlansCatalogState>({ kind: 'no-workspace' });
  let passivePlan = $state.raw<import('./features/plans/contracts.js').SupervisedPlan | null>(null);
  let passivePlanName = $state<string | null>(null);
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
  let userInputAnswers = $state<Record<string, string>>({});
  let chatTail = $state<HTMLElement | null>(null);
  let presentationSignal = '';
  const followTail = new ChatFollowTail({
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (frame) => cancelAnimationFrame(frame),
    reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    scrollTail: (behavior) => chatTail?.scrollIntoView({ block: 'end', behavior }),
  });
  const tailScheduler = new ChatTailScheduler(
    (fn) => void tick().then(fn),
    (reason) => {
      if (tab === 'chat') followTail.request(reason);
    },
  );
  let interactionAnnouncement = $derived.by(() => {
    const interaction = chatView?.interactions.findLast((item) => item.state !== 'pending');
    if (!interaction) return '';
    if (interaction.state === 'submitting') return 'Sending decision.';
    if (interaction.state === 'failed') return 'Could not send decision. Retry is available.';
    if (interaction.state === 'resolved') {
      return interaction.attemptedOutcome === 'denied'
        ? 'Decision denied.'
        : interaction.attemptedOutcome === 'dismissed'
          ? 'Request is no longer awaiting a response.'
          : interaction.attemptedOutcome === 'answered'
            ? 'Answers sent.'
            : 'Decision approved.';
    }
    return '';
  });
  const relay = createRelayClient((input, init) => authorizedFetch(input, init));
  const autopilotController = new AutopilotController(relay, (next) => (autopilotState = next));
  const activityController = new AgentActivityController({
    relay,
    publish: (next) => (activitySnapshots = new Map(next)),
    onEvent: (id, event) => autopilotController.observe(id, event),
    onAuthoritativeSnapshot: (id, snapshot) => autopilotController.applyAuthoritative(id, snapshot),
  });
  const chatController = new ChatController({
    relay,
    cache: createChatCache(),
    publish: (next) => (chatView = next),
    onSessionEvent: (event) => handleChatMetadataEvent(event),
    onRelayEvent: (event) => {
      if (sessionId) activityController.observe(sessionId, event);
    },
    onHistoryError: (error) => {
      shellStatus = reportRelayError(error, 'SESSION_HISTORY_READ_FAILED');
    },
    onSendError: (error, operationId) => {
      const feedback = relayFeedback(error, 'MESSAGE_SEND_FAILED');
      writerFeedback = feedback.message;
      retryOperationId = feedback.retryable ? operationId : null;
      shellStatus = reportRelayError(error, 'MESSAGE_SEND_FAILED');
    },
    onSendAccepted: (operationId) => {
      if (retryOperationId === operationId) {
        writerFeedback = null;
        retryOperationId = null;
      }
    },
  });
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
  const deviceClient = createDeviceClient((input, init) => authorizedFetch(input, init));
  const planController = createPlanController(
    { getPlan: relay.getPlan, closePlan: relay.closePlan },
    (next) => (planState = next),
  );
  const sessionCache = createSessionCache();
  const toastQueue = createToastQueue();
  const evidenceContext = new URLSearchParams(location.search).get('tree-evidence');
  const toastEvidence = new URLSearchParams(location.search).get('toast-evidence');
  const activityEvidence = new URLSearchParams(location.search).get('activity-evidence');
  // This tracks already-announced server request IDs; it does not drive rendering.
  const attentionToasts = createAttentionToastDedupe(window.sessionStorage);

  $effect(() => {
    for (const [id, attention] of autopilotState.attention) {
      const key = `${id}:${attention.requestId}`;
      if (attentionToasts.claim(key)) {
        toastQueue.enqueue({
          kind: 'error',
          code: `AUTOPILOT_ATTENTION_${attention.requestId}`,
          message: 'Autopilot needs your attention.',
        });
      }
    }
  });

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
      if (sessionId) message = await sessionCache.readDraft(sessionId);
      sessions = bootstrap.sessions;
      activityController.bootstrap(
        bootstrap.sessions.filter((session) => ['ready', 'turnActive'].includes(session.state)),
        sessionId,
      );
      autopilotController.bootstrap(
        bootstrap.sessions.filter((session) => ['ready', 'turnActive'].includes(session.state)),
      );
      void refreshRecentSessions();
      planController.select(sessionId);
      if (sessionId) {
        chatController.select(sessionId);
      }
    } catch (error) {
      shellStatus = reportRelayError(error, 'RELAY_UNAVAILABLE');
    }
  });

  $effect(() => {
    if (!chatTail) return;
    const observer = new IntersectionObserver(
      ([entry]) => followTail.observeTail(entry?.isIntersecting ?? false),
      { root: null },
    );
    observer.observe(chatTail);
    return () => observer.disconnect();
  });

  $effect(() => {
    const view = chatView;
    const currentTab = tab;
    const nextSignal = view
      ? JSON.stringify({
          messages: view.messages.map(({ id, text, complete }) => [id, text, complete]),
          activities: view.activities.map(({ id, label, detail }) => [id, label, detail]),
          interactions: view.interactions.map(({ key, state, attemptedOutcome }) => [
            key,
            state,
            attemptedOutcome,
          ]),
        })
      : '';
    if (!nextSignal || nextSignal === presentationSignal) return;
    presentationSignal = nextSignal;
    if (currentTab !== 'chat') return;
    scheduleTail('content');
  });

  function scheduleTail(reason: 'content' | 'explicit' | 'initial'): void {
    tailScheduler.schedule(reason);
  }
  function enterChatContext(): void {
    tailScheduler.invalidate();
    followTail.reset();
    tab = 'chat';
    scrollTabIntoInitialPosition('chat');
    scheduleTail('initial');
  }

  function setTheme(value: ThemeId): void {
    theme = selectTheme(value);
  }

  onDestroy(() => {
    tailScheduler.invalidate();
    followTail.cancel();
    chatController.dispose();
    activityController.dispose();
    autopilotController.dispose();
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
      shellStatus = errors.profile;
      return;
    }
    shellStatus = 'Starting session…';
    const session = await sessionStartController.start(sessionWorkspaceId, {
      sandbox,
      approvalPolicy,
      model: sessionModel,
      skillProfile: selectedSessionSkillProfile || undefined,
    });
    if (!session) {
      if (sessionStartState.error)
        shellStatus = reportRelayError(new Error(sessionStartState.error), 'SESSION_START_FAILED');
      return;
    }
    try {
      sessionId = session.id;
      planController.select(session.id);
      void sessionCache.saveSelectedSession(session.id);
      await refreshSessions();
      message = await sessionCache.readDraft(session.id);
      chatController.select(session.id);
      activityController.select(session.id);
      enterChatContext();
      shellStatus = 'Session started.';
    } catch (error) {
      shellStatus = reportRelayError(error, 'SESSION_START_FAILED');
    }
  }

  async function refreshSessions() {
    const epoch = ++sessionListEpoch;
    sessionListAbort?.abort();
    const abort = new AbortController();
    sessionListAbort = abort;
    try {
      const next = await relay.listSessions(abort.signal);
      if (epoch !== sessionListEpoch || abort.signal.aborted) return;
      sessions = next;
      const active = sessions.filter((session) => ['ready', 'turnActive'].includes(session.state));
      // Activity owns getSession reconciliation. Bootstrap seeds the shared
      // projection only; a late list can never replace sequenced authority.
      activityController.bootstrap(active, sessionId);
      autopilotController.bootstrap(active);
    } catch (error) {
      if (abort.signal.aborted || isAbortError(error)) return;
      throw error;
    } finally {
      if (sessionListAbort === abort) sessionListAbort = null;
    }
  }

  async function toggleAutopilot(id: string, enabled: boolean): Promise<void> {
    await autopilotController.toggle(id, enabled);
    if (id === sessionId) void refreshSessions().catch(() => {});
  }
  async function recoverAutopilot(id: string): Promise<void> {
    await toggleAutopilot(id, true);
    await tick();
    if (id === sessionId)
      document.getElementById(`chat-autopilot-${id}-button`)?.focus({ preventScroll: true });
  }
  async function resolveAutopilotAttention(
    id: string,
    action: 'resume' | 'disableAutopilot',
    guidance?: string,
  ): Promise<void> {
    await autopilotController.resolve(id, action, guidance);
    if (id === sessionId) void refreshSessions().catch(() => {});
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
      shellStatus = reportRelayError(error, 'SESSION_REFRESH_FAILED');
    }
  }

  async function openSession(id: string) {
    shellStatus = 'Opening session…';
    openingSessionId = id;
    const generation = ++openGeneration;
    try {
      sessionId = id;
      writerFeedback = null;
      retryOperationId = null;
      planController.select(id);
      void sessionCache.saveSelectedSession(id);
      chatController.select(id);
      activityController.select(id);
      enterChatContext();
      const draft = await sessionCache.readDraft(id);
      if (generation === openGeneration && sessionId === id) message = draft;
    } catch (error) {
      shellStatus = reportRelayError(error, 'SESSION_HISTORY_READ_FAILED');
    } finally {
      if (generation === openGeneration) openingSessionId = null;
    }
  }

  async function openRecentSession(recent: RecentSession) {
    shellStatus = 'Opening recent session…';
    try {
      const session = await relay.openRecentSession(recent.id, recent.cwd);
      if (!sessions.some((item) => item.id === session.id)) sessions = [...sessions, session];
      void refreshSessionLists();
      await openSession(session.id);
    } catch (error) {
      shellStatus = reportRelayError(error, 'SESSION_HISTORY_READ_FAILED');
    }
  }

  async function closeSession(id: string) {
    shellStatus = 'Closing session…';
    try {
      await relay.releaseSession(id);
      if (sessionId === id) {
        sessionId = null;
        tab = 'sessions';
        void sessionCache.saveSelectedSession(null);
        chatController.select(null);
        activityController.select(null);
        planController.select(null);
      }
      await refreshSessionLists();
      shellStatus = 'Session closed.';
    } catch (error) {
      shellStatus = `Could not close session: ${errorMessage(error)}`;
    }
  }

  async function forgetSession(id: string) {
    const forgottenSession = sessions.find((session) => session.id === id);
    try {
      await relay.forgetSession(id);
      if (sessionId === id) {
        chatController.select(null);
        activityController.select(null);
        sessionId = null;
        void sessionCache.saveSelectedSession(null);
        planController.select(null);
      }
      await refreshSessionLists();
      recentSessions = retainForgottenSession(recentSessions, forgottenSession);
    } catch (error) {
      shellStatus = `Could not forget session: ${errorMessage(error)}`;
    }
  }

  async function copyResumeCommand(command: string) {
    shellStatus = (await copyText(command))
      ? 'Resume command copied.'
      : 'Could not copy the resume command.';
  }

  async function selectSessionModel(model: string): Promise<void> {
    if (!sessionId || chatView?.activeTurnId) return;
    try {
      const updated = await relay.selectModel(sessionId, model);
      sessions = sessions.map((session) =>
        session.id === updated.id ? { ...session, ...updated } : session,
      );
      message = '';
      shellStatus = `Model changed to ${model}; it applies to the next turn.`;
    } catch (error) {
      shellStatus = `Could not change model: ${errorMessage(error)}`;
    }
  }

  async function sendMessage() {
    const operationId = createIdempotencyKey();
    void chatController.send(message, operationId);
    message = '';
    scheduleTail('explicit');
    if (sessionId) void sessionCache.saveDraft(sessionId, '');
  }

  async function retrySend(): Promise<void> {
    if (!retryOperationId) return;
    writerFeedback = null;
    await chatController.retryPrompt(retryOperationId);
  }

  async function interruptTurn() {
    await chatController.interrupt();
  }

  function reconcileVisibleHistory(): void {
    if (tab === 'chat' && sessionId) chatController.refresh();
  }

  function selectTab(next: Tab, focusChatPrompt = false): void {
    if (next === 'chat' && !chatEnabled) return;
    const changedTab = tab !== next;
    if (tab === 'chat' && next !== 'chat') {
      tailScheduler.invalidate();
      followTail.cancel();
    }
    tab = next;
    scrollTabIntoInitialPosition(next);
    if (next === 'chat') {
      reconcileVisibleHistory();
      followTail.reset();
      scheduleTail('initial');
      if (changedTab && focusChatPrompt) focusChatPromptOnDesktop();
    }
    if (next === 'git' && gitWorkspaceId) void gitController.refresh();
    if (next === 'plan') {
      if (sessionId) planController.refresh(sessionId);
      if (!changedTab) refreshPlanSurface();
    }
    if (next === 'sessions') {
      if (sessionSubview === 'profile-manager') void closeProfileManager(false);
      void refreshSessionLists();
    }
  }

  $effect(() => {
    const workspaceId = plansWorkspaceId;
    if (tab === 'plan') loadPlansCatalog(workspaceId);
  });

  let externalRefreshQueued = false;

  function queueVisibleExternalRefresh(): void {
    if (document.visibilityState !== 'visible' || externalRefreshQueued) return;
    externalRefreshQueued = true;
    queueMicrotask(() => {
      externalRefreshQueued = false;
      if (document.visibilityState !== 'visible') return;
      if (tab === 'git' && gitWorkspaceId) void gitController.refresh();
      if (tab === 'plan') refreshPlanSurface();
    });
  }

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
    passivePlanName = null;
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
        passivePlanName = planName;
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
    passivePlanName = null;
    hideLivePlan = true;
    loadPlansCatalog();
  }

  function refreshPlanSurface(): void {
    if (sessionId) planController.refresh(sessionId);
    if (passivePlanName) openWorkspacePlan(passivePlanName);
    else loadPlansCatalog();
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
      shellStatus =
        'Choose a workspace and available Codex profile before managing skill profiles.';
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
      if (target !== 'chat') window.scrollTo({ top: 0 });
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
    scheduleTail('explicit');
    await chatController.respond(requestId, { decision });
  }

  async function resolveUserInput(interaction: {
    requestId: string;
    kind: string;
    payload: unknown;
  }) {
    scheduleTail('explicit');
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
      await chatController.respond(interaction.requestId, response);
    } catch {
      shellStatus = 'Could not send quiz answers. Please try again.';
    }
  }

  async function resolvePermissions(interaction: { requestId: string; payload: unknown }) {
    const response = toPermissionApprovalResponse(interaction.payload);
    if (!response) {
      shellStatus = 'Codex sent an invalid permission request.';
      return;
    }
    scheduleTail('explicit');
    await chatController.respond(interaction.requestId, response);
  }

  function retryInteraction(interaction: { requestId: string; kind: string; payload: unknown }) {
    if (interaction.kind === 'quiz' || interaction.kind === 'userInput') {
      void resolveUserInput(interaction);
    } else if (interaction.kind === 'permissionsApproval') {
      void resolvePermissions(interaction);
    } else {
      void chatController.retryInteraction(interaction.requestId);
    }
  }

  function setUserInputAnswer(requestId: string, questionId: string, answer: string) {
    userInputAnswers[`${requestId}:${questionId}`] = answer;
  }

  function updateDraft(value: string) {
    message = value;
    if (sessionId) void sessionCache.saveDraft(sessionId, value);
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
    if (!submitsOnEnter(event) || chatView?.activeTurnId || chatView?.starting || !message.trim())
      return;
    event.preventDefault();
    void sendMessage();
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof DOMException
      ? error.name === 'AbortError'
      : error instanceof Error && error.name === 'AbortError';
  }

  function handleChatMetadataEvent(event: ProjectionEvent): void {
    const selectedId = sessionId;
    if (!selectedId) return;
    if (event.type === 'agent.activity.updated') {
      return;
    }
    if (
      event.type === 'session.updated' &&
      typeof event.payload === 'object' &&
      event.payload !== null
    ) {
      const updated = event.payload as RelaySession;
      if (updated.id === selectedId)
        sessions = sessions.map((item) =>
          item.id === selectedId ? { ...item, ...updated } : item,
        );
      return;
    }
    if (event.type !== 'plan.updated' && event.type !== 'plan.closed') return;
    planController.applyEvent(selectedId, event);
    if (event.type !== 'plan.updated' || !isRelayPlanUpdate(event.payload)) return;
    const reason = event.payload.reason;
    if (
      !reason ||
      !['authoring-start', 'work-start', 'supervision-start', 'resync'].includes(reason)
    )
      return;
    const signal = `${selectedId}:${event.sequence}`;
    if (signal === lastPlanOpenSignal) return;
    lastPlanOpenSignal = signal;
    tab = 'plan';
    scrollTabIntoInitialPosition('plan');
  }
</script>

<svelte:head>
  <title>Gestalt Mobile</title>
</svelte:head>

<svelte:window onfocus={queueVisibleExternalRefresh} />
<svelte:document onvisibilitychange={queueVisibleExternalRefresh} />

{#if activityEvidence === 'true'}
  <AgentActivityEvidence />
{:else if toastEvidence === 'error' || toastEvidence === 'stacked'}
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
    <!-- At phone widths the viewport becomes part of the document flow, so a
         readable notification never covers the header or an active control. -->
    <ToastViewport queue={toastQueue} />
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
          <AgentActivityIndicators
            activity={sessionId ? (activitySnapshots.get(sessionId) ?? null) : null}
          />
          <AutopilotControl
            autopilot={sessionId ? (autopilotState.snapshots.get(sessionId) ?? null) : null}
            controlId={`chat-autopilot-${sessionId ?? 'none'}`}
            pending={sessionId ? autopilotState.pending.has(sessionId) : false}
            error={sessionId ? (autopilotState.errors.get(sessionId) ?? null) : null}
            ontoggle={(enabled) => sessionId && toggleAutopilot(sessionId, enabled)}
          />
          <AutopilotAttention
            attention={sessionId ? (autopilotState.attention.get(sessionId) ?? null) : null}
            controlId={`chat-attention-${sessionId ?? 'none'}`}
            pending={sessionId ? autopilotState.pending.has(sessionId) : false}
            onresolve={(action, guidance) =>
              sessionId && resolveAutopilotAttention(sessionId, action, guidance)}
          />
          <AutopilotSafetyStop
            autopilot={sessionId ? (autopilotState.snapshots.get(sessionId) ?? null) : null}
            attention={sessionId ? (autopilotState.attention.get(sessionId) ?? null) : null}
            controlId={`chat-autopilot-safety-${sessionId ?? 'none'}`}
            pending={sessionId ? autopilotState.pending.has(sessionId) : false}
            onrecover={() => sessionId && void recoverAutopilot(sessionId)}
            ondisable={() => sessionId && toggleAutopilot(sessionId, false)}
          />
          <p class="visually-hidden" aria-live="polite" aria-atomic="true">
            {interactionAnnouncement}
          </p>
          {#if sessionId}
            <MessageList
              messages={chatView ? [...chatView.messages] : []}
              activities={chatView ? [...chatView.activities] : []}
              activeTurnId={chatView?.activeTurnId ?? null}
              autopilotAuditTruncated={chatView?.autopilotAuditTruncated ?? false}
              interactions={chatView ? [...chatView.interactions] : []}
              answers={userInputAnswers}
              onanswer={setUserInputAnswer}
              onquiz={(interaction) => void resolveUserInput(interaction)}
              onpermission={(interaction) => void resolvePermissions(interaction)}
              ondecision={(id, decision) => void resolveInteraction(id, decision)}
              onretry={retryInteraction}
            />
            <Composer
              status={chatView?.status ?? shellStatus}
              {message}
              activeTurnId={chatView?.activeTurnId ?? null}
              starting={chatView?.starting ?? false}
              detached={Boolean(
                sessions.find((session) => session.id === sessionId) &&
                !['ready', 'turnActive'].includes(
                  sessions.find((session) => session.id === sessionId)?.state ?? '',
                ),
              )}
              retryMessage={writerFeedback}
              retryable={retryOperationId !== null}
              models={sessionModels}
              onchange={updateDraft}
              onscrollbottom={() => scheduleTail('explicit')}
              onmodelselect={(model) => void selectSessionModel(model)}
              onsend={() => void sendMessage()}
              onretry={() => void retrySend()}
              oninterrupt={() => void interruptTurn()}
            />
            <div bind:this={chatTail} class="chat-tail" aria-hidden="true"></div>
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
            {activitySnapshots}
            autopilotSnapshots={autopilotState.snapshots}
            autopilotPending={autopilotState.pending}
            autopilotErrors={autopilotState.errors}
            autopilotAttention={autopilotState.attention}
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
            onautopilottoggle={toggleAutopilot}
            onautopilotresolve={resolveAutopilotAttention}
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

<style>
  .chat-view {
    margin-inline: calc(0.25rem - var(--page-inline-padding));
  }

  .chat-tail {
    block-size: 1px;
    scroll-margin-block-end: var(--bottom-navigation-clearance);
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
