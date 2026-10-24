/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  selfDebugPrompt,
  type DebugContext,
  type DebugProblem,
  type SelfDebugSession,
} from '../../../shared/contracts/self-debug.js';
import { RelaySession, type RelaySessionSnapshot } from '../sessions/model/relay-session.js';

/** DEBUG is a root thread using the same execution settings as Org executors. */
export async function debugExecutionSettings(
  source: RelaySessionSnapshot,
  defaults: () => Promise<SelfDebugSession['agent']>,
): Promise<SelfDebugSession['agent']> {
  if (!source.effectiveSkillSelection) throw new Error('DEBUG_SOURCE_SETTINGS_UNAVAILABLE');
  const settings = source.modelSettings;
  const fallback =
    settings?.executorModel && settings.executorReasoningEffort ? undefined : await defaults();
  const model = settings?.executorModel ?? fallback?.model;
  const reasoningEffort = settings?.executorReasoningEffort ?? fallback?.reasoningEffort;
  if (!model) throw new Error('DEBUG_EXECUTOR_CONFIGURATION_INVALID');
  return { name: 'root', model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export type CreateDebugDependencies = {
  createId(): string;
  now(): string;
  settings(source: RelaySessionSnapshot): Promise<SelfDebugSession['agent']>;
  capture(
    id: string,
    context: DebugContext,
    agent: SelfDebugSession['agent'],
  ): Promise<{ root: string; debug: SelfDebugSession; absoluteTracePath: string }>;
  createSession(
    id: string,
    root: string,
    agent: SelfDebugSession['agent'],
    source: RelaySessionSnapshot,
  ): Promise<RelaySessionSnapshot>;
  start(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot>;
  startTurn(
    session: RelaySessionSnapshot,
    prompt: string,
    messageId: string,
  ): Promise<RelaySessionSnapshot>;
  find(id: string): RelaySessionSnapshot | null;
  save(session: RelaySessionSnapshot): void;
  onStarted(session: RelaySessionSnapshot): void;
};

export async function createSelfDebugSession(
  context: DebugContext,
  deps: CreateDebugDependencies,
  problem?: DebugProblem,
): Promise<RelaySessionSnapshot> {
  const id = deps.createId();
  const source = deps.find(context.mobileSession);
  if (!source || source.threadId !== (context.sourceThread ?? context.codexThread))
    throw new Error('DEBUG_SOURCE_UNAVAILABLE');
  const agent = await deps.settings(source);
  const captured = await deps.capture(id, context, agent);
  let session = await deps.createSession(id, captured.root, agent, source);
  session = { ...session, selfDebug: captured.debug };
  deps.save(session);
  try {
    session = await deps.start(session);
    deps.save(session);
    session = await deps.startTurn(
      session,
      selfDebugPrompt(captured.debug, captured.absoluteTracePath, problem),
      `self-debug-root-${id}`,
    );
    deps.save(session);
    deps.onStarted(session);
    return session;
  } catch (error) {
    deps.save(
      RelaySession.rehydrate(deps.find(id) ?? session).requireAttention(deps.now()).snapshot,
    );
    throw error;
  }
}
