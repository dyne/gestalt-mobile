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
  import { createChatCache } from './features/chat/chat-cache.js';
  import {
    detachedChatUrl,
    detachedChatWindowName,
    readDetachedChatSession,
  } from './features/chat/detached-chat.js';
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
  import type { SubmittedQuizAnswer } from './features/chat/quiz-submission.js';
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
    type WorkspaceOrgPreview,
    type WorkspacePlanEntry,
  } from './features/sessions/relay-client.js';
  import { copyText } from './features/sessions/clipboard.js';
  import { createIdempotencyKey } from './features/sessions/idempotency-key.js';
  import { createPlanController, type PlanState } from './features/plans/plan-controller.js';
  import {
    isRelayPlanUpdate,
    isSupervisedPlan,
    type SupervisedPlan,
  } from './features/plans/contracts.js';
  import { weeklyQuotaRemaining } from './features/plans/weekly-quota.js';
  import { workspacePlanNameFromHref } from './features/plans/org-plan-link.js';
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
  import FileBrowser from './features/files/FileBrowser.svelte';

  const detachedSessionId = readDetachedChatSession(location.search);
  let chatView = $state<ChatViewState | null>(null);
  let tab = $state<Tab>(detachedSessionId ? 'chat' : 'sessions');
  let devicesOpen = $state(false);
  let scratchpadOpen = $state(false);
  let fileBrowserRoot = $state<WorkspaceOption | null>(null);
  let fileBrowserTrigger = $state<HTMLButtonElement | null>(null);
  let fileBrowserGitRefreshScheduled = false;
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
  let passivePlan = $state.raw<SupervisedPlan | WorkspaceOrgPreview | null>(null);
  let passivePlanName = $state<string | null>(null);
  let hideLivePlan = $state(false);
  let plansCatalogRequest: AbortController | null = null;
  let passivePlanRequest: AbortController | null = null;
  let plansCatalogGeneration = 0;
  let passivePlanGeneration = 0;
  let navigationFocus = $state<Tab | null>(null);
  let plansWorkspaceId = $derived(
    (sessions.find((session) => session.id === sessionId)?.workspaceId ?? sessionWorkspaceId) ||
      null,
  );
  let plansWorkspacePath = $derived(
    sessions.find((session) => session.id === sessionId)?.workspacePath ?? null,
  );
  let selectedSession = $derived(sessions.find((session) => session.id === sessionId) ?? null);
  let selectedSessionPath = $derived(displayWorkspacePath(selectedSession?.workspacePath ?? ''));
  function isWorkspaceOrgPreview(
    value: SupervisedPlan | WorkspaceOrgPreview,
  ): value is WorkspaceOrgPreview {
    return 'kind' in value && value.kind === 'org-source';
  }
  function observedSessions(active: RelaySession[]): RelaySession[] {
    return detachedSessionId ? active.filter((session) => session.id === sessionId) : active;
  }
  let visiblePlanState = $derived.by<PlanState | WorkspaceOrgPreview | null>(() => {
    if (passivePlan && isWorkspaceOrgPreview(passivePlan)) return passivePlan;
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
  let submittedQuizAnswers = $state.raw<Record<string, readonly SubmittedQuizAnswer[]>>({});
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
  const announcedAutopilotErrors = new Set<string>();

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

  $effect(() => {
    const active = new Set<string>();
    for (const [id, message] of autopilotState.errors) {
      const key = `${id}:${message}`;
      active.add(key);
      if (announcedAutopilotErrors.has(key)) continue;
      announcedAutopilotErrors.add(key);
      toastQueue.enqueue({ kind: 'error', message });
    }
    for (const key of announcedAutopilotErrors) {
      if (!active.has(key)) announcedAutopilotErrors.delete(key);
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
      if (!detachedSessionId) await refreshSkillProfiles();
      sessionExpandedIds = defaultExpandedIds(workspaceTree);
      gitExpandedIds = defaultExpandedIds(workspaceTree);
      const remembered = detachedSessionId ? null : await sessionCache.readSelectedSession();
      sessionId = detachedSessionId
        ? (bootstrap.sessions.find((session) => session.id === detachedSessionId)?.id ?? null)
        : bootstrap.sessions.some((session) => session.id === remembered)
          ? remembered
          : (bootstrap.sessions[0]?.id ?? null);
      if (sessionId) message = await sessionCache.readDraft(sessionId);
      sessions = bootstrap.sessions;
      const active = observedSessions(
        bootstrap.sessions.filter((session) => ['ready', 'turnActive'].includes(session.state)),
      );
      activityController.bootstrap(active, sessionId);
      autopilotController.bootstrap(active);
      if (!detachedSessionId) void refreshRecentSessions();
      planController.select(sessionId);
      if (sessionId) {
        chatController.select(sessionId);
      } else if (detachedSessionId) {
        shellStatus = 'This session is no longer open in Gestalt Mobile.';
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
    focusChatPrompt();
  }

  function setTheme(value: ThemeId): void {
    theme = selectTheme(value);
  }

  function detachChat(): void {
    if (!sessionId) return;
    const detachedWindow = window.open(
      detachedChatUrl(location.href, sessionId),
      detachedChatWindowName(sessionId),
      'popup,width=760,height=900',
    );
    if (!detachedWindow) {
      toastQueue.enqueue({
        kind: 'error',
        message: 'The Chat window was blocked. Allow pop-ups for this site and try again.',
      });
      return;
    }
    try {
      detachedWindow.opener = null;
    } catch {
      // The named window may already have navigated away; focusing it is still safe.
    }
    detachedWindow.focus();
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
      chatController.select(session.id, { history: 'empty' });
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
      const active = observedSessions(
        sessions.filter((session) => ['ready', 'turnActive'].includes(session.state)),
      );
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
    clearDraftAfterSend();
  }

  async function queueMessage() {
    const operationId = createIdempotencyKey();
    void chatController.queue(message, operationId);
    clearDraftAfterSend();
  }

  async function interruptAndSendMessage() {
    const operationId = createIdempotencyKey();
    void chatController.interruptAndSend(message, operationId);
    clearDraftAfterSend();
  }

  function clearDraftAfterSend(): void {
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

  function selectTab(next: Tab): void {
    if (detachedSessionId) return;
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
      if (changedTab) focusChatPrompt();
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
        if (!visiblePlanState)
          toastQueue.enqueue({
            kind: 'error',
            code: 'WORKSPACE_PLANS_READ_FAILED',
            message: 'Workspace Org files could not be listed. Try opening the Plan tab again.',
          });
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
    const opened = sessionId
      ? relay.openSessionPlan(sessionId, planName)
      : relay.getWorkspacePlan(workspaceId, planName, request.signal);
    void opened
      .then((plan) => {
        if (generation !== passivePlanGeneration || request.signal.aborted) return;
        passivePlan = plan;
        passivePlanName = planName;
        hideLivePlan = false;
      })
      .catch(() => {
        if (generation !== passivePlanGeneration || request.signal.aborted) return;
        toastQueue.enqueue({
          kind: 'error',
          code: `WORKSPACE_PLAN_OPEN_${planName}`,
          message: 'This Org file could not be opened. Check that it is readable and try again.',
        });
      });
  }

  function openLinkedOrgPlan(href: string): void {
    const workspaceId = plansWorkspaceId;
    const workspacePath = plansWorkspacePath;
    const planName = workspacePath ? workspacePlanNameFromHref(href, workspacePath) : null;
    if (!workspaceId || !planName) {
      toastQueue.enqueue({
        kind: 'error',
        code: 'ORG_LINK_OUTSIDE_WORKSPACE',
        message: 'This Org file is not inside the selected workspace and cannot be opened.',
      });
      return;
    }

    selectTab('plan');
    void tick().then(() => {
      if (plansWorkspaceId !== workspaceId || plansWorkspacePath !== workspacePath) return;
      openWorkspacePlan(planName);
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

  function focusChatPrompt(): void {
    void tick().then(() => {
      if (tab === 'chat') document.getElementById('message')?.focus({ preventScroll: true });
    });
  }

  function selectGitWorkspace(node: WorkspaceOption): void {
    gitController.select(node.id);
    pushConfirmationOpen = false;
  }

  function openFileBrowser(trigger: HTMLButtonElement): void {
    const selected = gitWorkspaceId ? findTreeNode(workspaceTree, gitWorkspaceId) : null;
    if (!selected) return;
    fileBrowserRoot = selected;
    fileBrowserTrigger = trigger;
  }

  async function closeFileBrowser(): Promise<void> {
    fileBrowserRoot = null;
    await tick();
    fileBrowserTrigger?.focus({ preventScroll: true });
  }

  function scheduleFileBrowserGitRefresh(): void {
    if (fileBrowserGitRefreshScheduled) return;
    fileBrowserGitRefreshScheduled = true;
    queueMicrotask(() => {
      fileBrowserGitRefreshScheduled = false;
      if (gitWorkspaceId) void gitController.refresh();
    });
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
    submittedQuizAnswers = {
      ...submittedQuizAnswers,
      [interaction.requestId]: quiz.questions.map((question, index) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        answer: answers[index]?.answer ?? '',
      })),
    };
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
    if (event.type === 'plan.closed') {
      sessions = sessions.map((item) =>
        item.id === selectedId ? { ...item, plan: undefined } : item,
      );
      return;
    }
    const plan = isRelayPlanUpdate(event.payload)
      ? event.payload.plan
      : isSupervisedPlan(event.payload)
        ? event.payload
        : null;
    if (plan)
      sessions = sessions.map((item) => (item.id === selectedId ? { ...item, plan } : item));
  }
</script>

<svelte:head>
  <title
    >{detachedSessionId && selectedSessionPath
      ? `Chat · ${selectedSessionPath} · Gestalt Mobile`
      : 'Gestalt Mobile'}</title
  >
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
    {#if !devicesOpen && !detachedSessionId}<AppHeader
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
        ondetach={tab === 'chat' && sessionId ? detachChat : undefined}
      />{/if}
    {#if detachedSessionId}
      <header class="detached-chat-header">
        <div class="detached-chat-context">
          <span>Chat</span>
          <strong title={selectedSessionPath || detachedSessionId}
            >{selectedSessionPath || detachedSessionId}</strong
          >
        </div>
        {#if selectedSession?.model}
          <span class="detached-chat-model">{selectedSession.model}</span>
        {/if}
      </header>
    {/if}
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
              submittedAnswers={submittedQuizAnswers}
              onanswer={setUserInputAnswer}
              onquiz={(interaction) => void resolveUserInput(interaction)}
              onpermission={(interaction) => void resolvePermissions(interaction)}
              ondecision={(id, decision) => void resolveInteraction(id, decision)}
              onretry={retryInteraction}
              onopenorg={openLinkedOrgPlan}
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
              onqueue={() => void queueMessage()}
              oninterruptsend={() => void interruptAndSendMessage()}
              onretry={() => void retrySend()}
              oninterrupt={() => void interruptTurn()}
            />
            <div class="chat-controls" aria-label="Chat controls">
              <AutopilotControl
                compact
                autopilot={autopilotState.snapshots.get(sessionId) ?? null}
                controlId={`chat-autopilot-${sessionId}`}
                pending={autopilotState.pending.has(sessionId)}
                ontoggle={(enabled) => sessionId && toggleAutopilot(sessionId, enabled)}
              />
              <AgentActivityIndicators
                compact
                activity={activitySnapshots.get(sessionId) ?? null}
                rootModel={sessions.find((session) => session.id === sessionId)?.model ??
                  defaultSessionModel}
              />
            </div>
            <div bind:this={chatTail} class="chat-tail" aria-hidden="true"></div>
          {:else}
            <p>
              {detachedSessionId
                ? shellStatus
                : 'Start a session from the Sessions tab to chat with Codex.'}
            </p>
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
          onbrowsefiles={openFileBrowser}
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
      {#if fileBrowserRoot}
        <FileBrowser
          root={fileBrowserRoot}
          listDirectory={relay.listWorkspaceDirectory}
          copyEntry={relay.copyWorkspaceEntry}
          moveEntry={relay.moveWorkspaceEntry}
          deleteEntry={relay.deleteWorkspaceEntry}
          uploadFile={relay.uploadWorkspaceFile}
          onclose={() => void closeFileBrowser()}
          onerror={(error) => reportRelayError(error, 'WORKSPACE_FILES_READ_FAILED')}
          onsuccess={(message) => toastQueue.enqueue({ kind: 'success', message })}
          onmutation={scheduleFileBrowserGitRefresh}
        />
      {/if}

      {#if !detachedSessionId}
        <BottomNavigation
          activeTab={tab}
          {chatEnabled}
          focusTab={navigationFocus}
          onselect={selectTab}
        />
      {/if}
    {/if}
  </main>
  {#if scratchpadOpen}<Scratchpad onclose={closeScratchpad} />{/if}
{/if}

<style>
  .chat-view {
    margin-inline: calc(0.25rem - var(--page-inline-padding));
  }

  .detached-chat-header {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    box-sizing: border-box;
    inline-size: 100vw;
    margin: calc(-1rem - env(safe-area-inset-top)) calc(50% - 50vw) 1.5rem;
    padding: calc(1rem + env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.75rem
      max(1rem, env(safe-area-inset-left));
    background: color-mix(in srgb, var(--theme-page) 88%, transparent);
    border-block-end: 1px solid color-mix(in srgb, var(--theme-border) 72%, transparent);
    box-shadow: 0 0.35rem 1rem color-mix(in srgb, var(--theme-shadow) 28%, transparent);
    -webkit-backdrop-filter: blur(0.75rem) saturate(1.2);
    backdrop-filter: blur(0.75rem) saturate(1.2);
  }

  .detached-chat-context {
    display: flex;
    align-items: baseline;
    min-inline-size: 0;
    gap: 0.75rem;
  }

  .detached-chat-context span {
    flex: 0 0 auto;
    font-family: var(--theme-font-display);
    font-weight: 700;
  }

  .detached-chat-context strong {
    min-inline-size: 0;
    overflow: hidden;
    font-size: 0.875rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detached-chat-model {
    flex: 0 0 auto;
    color: var(--theme-text-muted);
    font-family: var(--theme-font-code);
    font-size: 0.75rem;
  }

  main:has(.detached-chat-header) {
    padding-block-end: max(1rem, env(safe-area-inset-bottom));
  }

  main:has(.detached-chat-header) .chat-tail {
    scroll-margin-block-end: max(1rem, env(safe-area-inset-bottom));
  }

  @media (max-width: 32rem) {
    .detached-chat-model {
      display: none;
    }
  }

  .chat-tail {
    block-size: 1px;
    scroll-margin-block-end: var(--bottom-navigation-clearance);
  }

  .chat-controls {
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-start;
    gap: 0.35rem;
    min-inline-size: 0;
    margin-block-start: 0.625rem;
  }

  .chat-controls > :global(*) {
    flex: 1 1 0;
    min-inline-size: 0;
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
