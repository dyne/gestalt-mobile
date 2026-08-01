/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  isSupervisedPlan,
  isRelayPlanUpdate,
  type RelayPlanEvent,
  type SupervisedPlan,
} from './contracts.js';

export type PlanState =
  | Readonly<{ kind: 'unavailable'; sessionId: string | null }>
  | Readonly<{ kind: 'loading'; sessionId: string }>
  | Readonly<{ kind: 'ready'; sessionId: string; plan: SupervisedPlan }>
  | Readonly<{ kind: 'closing'; sessionId: string; plan: SupervisedPlan }>
  | Readonly<{ kind: 'error'; sessionId: string; error: string; plan?: SupervisedPlan }>;

export type PlanTransport = Readonly<{
  getPlan(sessionId: string, signal: AbortSignal): Promise<SupervisedPlan | null>;
  closePlan(sessionId: string): Promise<void>;
}>;

export type PlanController = Readonly<{
  select(sessionId: string | null): void;
  refresh(sessionId: string): void;
  applyEvent(sessionId: string, event: RelayPlanEvent): void;
  close(): Promise<'chat' | null>;
  dispose(): void;
}>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load the plan.';
}

function cloneStep(step: SupervisedPlan['steps'][number]): SupervisedPlan['steps'][number] {
  return {
    ...step,
    ...(step.skills ? { skills: [...step.skills] } : {}),
    description: { ...step.description },
    children: step.children.map(cloneStep),
  };
}

function clonePlan(plan: SupervisedPlan): SupervisedPlan {
  return { ...plan, steps: plan.steps.map(cloneStep) };
}

function isUnavailableForSession(state: PlanState, sessionId: string): boolean {
  return state.kind === 'unavailable' && state.sessionId === sessionId;
}

/** Owns the plan projection for exactly one selected relay session. */
export function createPlanController(
  transport: PlanTransport,
  onchange: (state: PlanState) => void,
): PlanController {
  let selectedSessionId: string | null = null;
  let state: PlanState = { kind: 'unavailable', sessionId: null };
  let generation = 0;
  let stateGeneration = 0;
  let request: AbortController | null = null;
  let lastPlanSequence = 0;

  const publish = (next: PlanState) => {
    ++stateGeneration;
    state = next;
    onchange(next);
  };

  const load = (sessionId: string, preserve: SupervisedPlan | undefined) => {
    request?.abort();
    request = new AbortController();
    const loadGeneration = ++generation;
    const sequenceAtRequest = lastPlanSequence;
    if (!preserve) publish({ kind: 'loading', sessionId });
    void transport
      .getPlan(sessionId, request.signal)
      .then((plan) => {
        if (loadGeneration !== generation || selectedSessionId !== sessionId) return;
        if (lastPlanSequence !== sequenceAtRequest) return;
        publish(plan ? { kind: 'ready', sessionId, plan: clonePlan(plan) } : { kind: 'unavailable', sessionId });
      })
      .catch((error: unknown) => {
        if (request?.signal.aborted || loadGeneration !== generation || selectedSessionId !== sessionId)
          return;
        publish({ kind: 'error', sessionId, error: errorMessage(error), ...(preserve ? { plan: preserve } : {}) });
      });
  };

  return {
    select(sessionId) {
      request?.abort();
      selectedSessionId = sessionId;
      lastPlanSequence = 0;
      if (!sessionId) {
        ++generation;
        publish({ kind: 'unavailable', sessionId: null });
        return;
      }
      load(sessionId, undefined);
    },
    refresh(sessionId) {
      if (selectedSessionId !== sessionId) return;
      const plan = state.kind === 'ready' || state.kind === 'closing' ? state.plan : state.kind === 'error' ? state.plan : undefined;
      load(sessionId, plan);
    },
    applyEvent(sessionId, event) {
      if (selectedSessionId !== sessionId || event.sequence <= lastPlanSequence) return;
    if (event.type === 'plan.updated' && (isSupervisedPlan(event.payload) || isRelayPlanUpdate(event.payload))) {
      const plan = isRelayPlanUpdate(event.payload) ? event.payload.plan : event.payload;
      lastPlanSequence = event.sequence;
      publish({ kind: 'ready', sessionId, plan: clonePlan(plan) });
      }
      if (event.type === 'plan.closed') {
        lastPlanSequence = event.sequence;
        publish({ kind: 'unavailable', sessionId });
      }
    },
    async close() {
      if ((state.kind !== 'ready' && state.kind !== 'error') || !state.plan?.allDone) return null;
      const { sessionId, plan } = state;
      publish({ kind: 'closing', sessionId, plan });
      const closeStateGeneration = stateGeneration;
      try {
        await transport.closePlan(sessionId);
        if (selectedSessionId !== sessionId) return null;
        if (stateGeneration === closeStateGeneration) {
          publish({ kind: 'unavailable', sessionId });
          return 'chat';
        }
        return isUnavailableForSession(state, sessionId) ? 'chat' : null;
      } catch (error) {
        if (selectedSessionId !== sessionId) return null;
        if (stateGeneration === closeStateGeneration) {
          publish({ kind: 'error', sessionId, plan, error: errorMessage(error) });
          return null;
        }
        return isUnavailableForSession(state, sessionId) ? 'chat' : null;
      }
    },
    dispose() {
      request?.abort();
      request = null;
      selectedSessionId = null;
      ++generation;
      publish({ kind: 'unavailable', sessionId: null });
    },
  };
}
