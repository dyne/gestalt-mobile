/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  selfDebugPrompt,
  type DebugContext,
  type SelfDebugSession,
} from '../../../shared/contracts/self-debug.js';
import { RelaySession, type RelaySessionSnapshot } from '../sessions/model/relay-session.js';

export type CreateDebugDependencies = {
  createId(): string;
  now(): string;
  settings(): Promise<SelfDebugSession['agent']>;
  capture(
    id: string,
    context: DebugContext,
    agent: SelfDebugSession['agent'],
  ): Promise<{ root: string; debug: SelfDebugSession; absoluteTracePath: string }>;
  askSource(id: string, context: DebugContext, debug: SelfDebugSession): Promise<void>;
  createSession(
    id: string,
    root: string,
    agent: SelfDebugSession['agent'],
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
): Promise<RelaySessionSnapshot> {
  const id = deps.createId();
  const agent = await deps.settings();
  const captured = await deps.capture(id, context, agent);
  // Diagnostic collection is best effort; source-agent failure never blocks the new root.
  try {
    await deps.askSource(id, context, captured.debug);
  } catch {
    /* Captured evidence remains sufficient to begin. */
  }
  let session = await deps.createSession(id, captured.root, agent);
  session = { ...session, selfDebug: captured.debug };
  deps.save(session);
  try {
    session = await deps.start(session);
    deps.save(session);
    session = await deps.startTurn(
      session,
      selfDebugPrompt(captured.debug, captured.absoluteTracePath),
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
