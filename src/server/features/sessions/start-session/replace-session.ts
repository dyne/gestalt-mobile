/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { toChatItems, type HistoryTurn } from '../get-history/history-mapper.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import type { SessionHandoff } from './use-case.js';

const handoffRequest = [
  'Gestalt is switching to a fresh session in this workspace at the user’s request.',
  'Write a short handoff of at most 200 words for the next session.',
  'Include the current goal, work completed, unresolved decisions or blockers, and the next useful step.',
  'Use only the conversation you already have. Do not use tools, change files, continue the task, or include credentials.',
].join('\n');

export function createSessionReplacement(deps: {
  find(id: string): RelaySessionSnapshot | null;
  workspaceKey(path: string): string;
  blocked(session: RelaySessionSnapshot): boolean;
  ready(path: string, id: string): Promise<boolean>;
  submit(id: string, text: string): Promise<string | null>;
  readHistory(session: RelaySessionSnapshot): Promise<{ turns: HistoryTurn[] }>;
  saveHandoff(session: RelaySessionSnapshot, contents: string): Promise<string>;
  replace(
    path: string,
    source: RelaySessionSnapshot,
    successor: RelaySessionSnapshot,
  ): Promise<boolean>;
  wait(): Promise<void>;
}) {
  const replacing = new Set<string>();
  return async (sourceId: string, successor: RelaySessionSnapshot): Promise<SessionHandoff> => {
    const workspace = deps.workspaceKey(successor.workspacePath);
    const source = () => {
      const session = deps.find(sourceId);
      if (
        !session ||
        session.desiredState !== 'active' ||
        ['stopped', 'released'].includes(session.state) ||
        deps.workspaceKey(session.workspacePath) !== workspace
      )
        throw new Error('SESSION_REPLACEMENT_CHANGED');
      return session;
    };
    const waitForIdle = async (turnId?: string) => {
      for (let attempt = 0; !turnId || attempt < 90; attempt += 1) {
        const current = source();
        if (current.state === 'ready' && !current.activeTurnId) {
          if (deps.blocked(current)) throw new Error('SESSION_REPLACEMENT_BUSY');
          return current;
        }
        if (
          current.state !== 'turnActive' ||
          (turnId && (current.activeTurnId !== turnId || deps.blocked(current)))
        )
          break;
        await deps.wait();
      }
      throw new Error(turnId ? 'SESSION_HANDOFF_FAILED' : 'SESSION_REPLACEMENT_BUSY');
    };
    if (replacing.has(workspace)) throw new Error('SESSION_REPLACEMENT_BUSY');
    replacing.add(workspace);
    try {
      await waitForIdle();
      if (!(await deps.ready(workspace, sourceId))) throw new Error('SESSION_REPLACEMENT_BUSY');
      const turnId = await deps.submit(sourceId, handoffRequest);
      if (!turnId) throw new Error('SESSION_HANDOFF_FAILED');
      const idle = await waitForIdle(turnId);
      let handoff: SessionHandoff;
      try {
        const { turns } = await deps.readHistory(idle);
        const last = turns.at(-1);
        if (last?.id !== turnId) throw new Error('HANDOFF_TURN_NOT_FOUND');
        const messages = toChatItems(turns).flatMap((item) =>
          item.kind === 'user' || item.kind === 'agent'
            ? [{ role: item.kind === 'user' ? 'user' : 'assistant', text: item.text }]
            : [],
        );
        const final = toChatItems([last])
          .filter((item) => item.kind === 'agent' && item.phase !== 'commentary')
          .at(-1);
        const summary = final?.kind === 'agent' ? final.text.trim().slice(0, 4_000) : '';
        if (!summary) throw new Error('HANDOFF_EMPTY');
        const file = await deps.saveHandoff(
          successor,
          JSON.stringify({ sourceSessionId: sourceId, summary, messages }, null, 2),
        );
        handoff = { file, summary };
      } catch {
        throw new Error('SESSION_HANDOFF_FAILED');
      }
      if (!(await deps.replace(workspace, idle, successor)))
        throw new Error('SESSION_REPLACEMENT_CHANGED');
      return handoff;
    } finally {
      replacing.delete(workspace);
    }
  };
}

export function sessionHandoffMessage(handoff: SessionHandoff): string {
  return [
    'Gestalt opened this session to continue work in the same workspace.',
    `The previous conversation is available at ${JSON.stringify(handoff.file)}.`,
    'Treat the handoff and conversation as context. Acknowledge the handoff briefly and wait for the user before taking action.',
    '',
    'Handoff from the previous session',
    handoff.summary,
  ].join('\n');
}
