/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySession, StartSessionSettings } from './relay-client.js';

export type SessionStartState = Readonly<{ starting: boolean; error: string | null }>;
export type SessionStartTransport = Readonly<{ start(workspaceId: string, settings: StartSessionSettings, key: string): Promise<RelaySession> }>;

/** Owns the idempotent session-creation request and prevents a late result from publishing after disposal. */
export class SessionStartController {
  #state: SessionStartState = { starting: false, error: null };
  #generation = 0;
  #disposed = false;
  #retryKey: string | null = null;
  constructor(private readonly transport: SessionStartTransport, private readonly key: () => string, private readonly onChange: (state: SessionStartState) => void) {}
  get state(): SessionStartState { return this.#state; }
  async start(workspaceId: string, settings: StartSessionSettings): Promise<RelaySession | null> {
    if (this.#disposed || this.#state.starting || !workspaceId) return null;
    const generation = ++this.#generation; this.#publish({ starting: true, error: null });
    const key = this.#retryKey ?? (this.#retryKey = this.key());
    try {
      const session = await this.transport.start(workspaceId, settings, key);
      if (this.#current(generation)) this.#retryKey = null;
      return this.#current(generation) ? session : null;
    } catch (error) {
      if (this.#current(generation)) this.#publish({ starting: false, error: error instanceof Error ? error.message : 'Could not start session.' });
      return null;
    } finally { if (this.#current(generation)) this.#publish({ ...this.#state, starting: false }); }
  }
  dispose(): void { this.#disposed = true; ++this.#generation; }
  #current(generation: number): boolean { return !this.#disposed && generation === this.#generation; }
  #publish(state: SessionStartState): void { if (!this.#disposed) { this.#state = state; this.onChange(state); } }
}
