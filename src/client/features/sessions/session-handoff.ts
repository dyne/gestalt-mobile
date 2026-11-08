/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySession } from './relay-client.js';
import type { SessionDraft } from './session-cache.js';

export type SessionHandoffPorts = {
  publish(session: RelaySession): void;
  warn(message: string): void;
  select(session: RelaySession, history: 'empty' | 'load'): void;
  saveSelectedSession(id: string): Promise<void>;
  refreshRoster(): Promise<void>;
  readDraft(id: string): Promise<SessionDraft>;
  restoreDraft(id: string, draft: SessionDraft): void;
};

/** Ordinary session presentation, separate from session creation and its caller's destination. */
export async function handoffSession(
  session: RelaySession,
  ports: SessionHandoffPorts,
  options: { history: 'empty' | 'load'; isCurrent(): boolean; present?(): void },
): Promise<boolean> {
  // Persisted sessions stay discoverable even when the initiating view has gone away.
  ports.publish(session);
  if (!options.isCurrent()) {
    await ports.refreshRoster();
    return false;
  }
  for (const warning of session.effectiveSkillSelection?.warnings ?? []) ports.warn(warning);
  ports.select(session, options.history);
  await ports.saveSelectedSession(session.id);
  await ports.refreshRoster();
  if (!options.isCurrent()) return false;
  const draft = await ports.readDraft(session.id);
  if (!options.isCurrent()) return false;
  ports.restoreDraft(session.id, draft);
  options.present?.();
  return true;
}

/** Separates stale presentation from ownership of the ordinary Open busy indicator. */
export class SessionPresentation {
  #generation = 0;
  #opening: symbol | null = null;
  #disposed = false;
  constructor(private readonly openingChanged: (id: string | null) => void) {}
  invalidate(): void {
    ++this.#generation;
    this.#opening = null;
    this.openingChanged(null);
  }
  begin(): () => boolean {
    this.invalidate();
    const generation = this.#generation;
    return () => !this.#disposed && generation === this.#generation;
  }
  beginOpen(id: string): { isCurrent(): boolean; finish(): void } {
    if (this.#disposed) return { isCurrent: () => false, finish: () => {} };
    const isCurrent = this.begin();
    const owner = Symbol(id);
    this.#opening = owner;
    this.openingChanged(id);
    return {
      isCurrent,
      finish: () => {
        if (this.#opening !== owner) return;
        this.#opening = null;
        this.openingChanged(null);
      },
    };
  }
  dispose(): void {
    this.#disposed = true;
    this.invalidate();
  }
}
