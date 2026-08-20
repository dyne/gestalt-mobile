/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isAgentActivitySnapshot, type AgentActivitySnapshot } from './contracts.js';
type Event = { sequence: number; type: string; payload: unknown };
export type AuthoritativeSessionSnapshot = {
  agentActivity?: unknown;
  autopilot?: unknown;
  pendingInteractions?: unknown;
  currentSequence?: number;
};
type Relay = {
  getSession(id: string): Promise<AuthoritativeSessionSnapshot>;
  refreshActivity(id: string): Promise<void>;
};
type Options = Readonly<{
  relay: Relay;
  publish: (items: ReadonlyMap<string, AgentActivitySnapshot>) => void;
  onEvent?: (id: string, event: Event) => void;
  /** The sole reconciliation owner forwards complete getSession authority. */
  onAuthoritativeSnapshot?: (id: string, snapshot: AuthoritativeSessionSnapshot) => void;
  websocket?: (url: string) => WebSocket;
  location?: Location;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  reconnectDelaysMs?: readonly number[];
}>;

/** Session-local projection; Chat calls observe for its selected stream, cards own only other streams. */
export class AgentActivityController {
  #snapshots = new Map<string, AgentActivitySnapshot>();
  #cursors = new Map<string, number>();
  #wanted = new Set<string>();
  #sockets = new Map<string, WebSocket>();
  #versions = new Map<string, number>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #resyncing = new Map<string, Promise<void>>();
  #reconnectAttempts = new Map<string, number>();
  #selected: string | null = null;
  #disposed = false;
  #options: Required<Pick<Options, 'websocket' | 'location' | 'setTimeout' | 'clearTimeout'>> &
    Options;
  constructor(options: Options) {
    this.#options = {
      ...options,
      websocket: options.websocket ?? ((url) => new WebSocket(url)),
      location: options.location ?? location,
      setTimeout: options.setTimeout ?? setTimeout,
      clearTimeout: options.clearTimeout ?? clearTimeout,
    };
  }
  get(id: string | null) {
    return id ? (this.#snapshots.get(id) ?? null) : null;
  }
  bootstrap(
    sessions: readonly { id: string; agentActivity?: unknown }[],
    selected: string | null,
  ): void {
    for (const session of sessions)
      // List snapshots have no journal sequence. They seed only an empty projection;
      // a socket event or authoritative getSession response must always win afterwards.
      if (
        !this.#snapshots.has(session.id) &&
        isAgentActivitySnapshot(session.agentActivity, session.id)
      )
        this.#apply(session.id, this.#cursors.get(session.id) ?? 0, session.agentActivity);
    this.sync(
      sessions.map((s) => s.id),
      selected,
    );
  }
  sync(ids: readonly string[], selected: string | null): void {
    if (this.#disposed) return;
    this.#selected = selected;
    this.#wanted = new Set(ids);
    for (const id of this.#wanted) if (!this.#versions.has(id)) this.#versions.set(id, 0);
    for (const id of [...this.#versions.keys()]) if (!this.#wanted.has(id)) this.remove(id);
    for (const [id, socket] of this.#sockets)
      if (id === selected || !this.#wanted.has(id)) {
        socket.close();
        this.#sockets.delete(id);
      }
    for (const id of this.#wanted) {
      void this.hydrate(id);
      if (id !== selected && !this.#sockets.has(id)) this.#open(id);
    }
  }
  select(id: string | null): void {
    this.sync([...this.#wanted], id);
  }
  remove(id: string): void {
    this.#wanted.delete(id);
    this.#versions.set(id, (this.#versions.get(id) ?? 0) + 1);
    this.#sockets.get(id)?.close();
    this.#sockets.delete(id);
    const timer = this.#timers.get(id);
    if (timer) this.#options.clearTimeout(timer);
    this.#timers.delete(id);
    this.#resyncing.delete(id);
    this.#reconnectAttempts.delete(id);
    this.#snapshots.delete(id);
    this.#cursors.delete(id);
    this.#options.publish(this.#snapshots);
  }
  observe(id: string, event: Event): void {
    if (this.#disposed || !this.#wanted.has(id) || !Number.isInteger(event.sequence)) return;
    const cursor = this.#cursors.get(id) ?? 0;
    if (event.sequence <= cursor) return;
    if (event.sequence > cursor + 1) {
      this.#cursors.set(id, event.sequence - 1);
      void this.resync(id);
    }
    this.#cursors.set(id, event.sequence);
    this.#options.onEvent?.(id, event);
    if (event.type === 'agent.activity.updated' && isAgentActivitySnapshot(event.payload, id))
      this.#apply(id, event.sequence, event.payload);
  }
  async hydrate(id: string): Promise<void> {
    const version = this.#versions.get(id) ?? 0;
    const requestedCursor = this.#cursors.get(id) ?? 0;
    try {
      const response = await this.#options.relay.getSession(id);
      if (!this.#current(id, version)) return;
      const cursor = this.#cursors.get(id) ?? 0;
      const responseSequence = response.currentSequence;
      if (Number.isInteger(responseSequence)) {
        if (responseSequence! < cursor) return;
        this.#cursors.set(id, responseSequence!);
        if (isAgentActivitySnapshot(response.agentActivity, id))
          this.#apply(id, responseSequence!, response.agentActivity);
        this.#options.onAuthoritativeSnapshot?.(id, response);
      } else if (
        cursor === requestedCursor &&
        isAgentActivitySnapshot(response.agentActivity, id)
      ) {
        // An unsequenced bootstrap response is only a hint; never overwrite a socket update.
        this.#apply(id, cursor, response.agentActivity);
        this.#options.onAuthoritativeSnapshot?.(id, response);
      }
    } catch {
      this.#stale(id);
    }
  }
  async resync(id: string): Promise<void> {
    const running = this.#resyncing.get(id);
    if (running) return running;
    const version = this.#versions.get(id) ?? 0;
    this.#stale(id);
    // The finally callback compares this exact promise, so it cannot clear a newer resync.
    /* eslint-disable prefer-const */
    let task!: Promise<void>;
    task = (async () => {
      try {
        await this.#options.relay.refreshActivity(id);
        if (this.#current(id, version)) await this.hydrate(id);
      } catch {
        /* retained stale hint */
      } finally {
        if (this.#resyncing.get(id) === task) this.#resyncing.delete(id);
      }
    })();
    /* eslint-enable prefer-const */
    this.#resyncing.set(id, task);
    return task;
  }
  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#wanted]) this.remove(id);
  }
  #current(id: string, version: number) {
    return !this.#disposed && this.#wanted.has(id) && this.#versions.get(id) === version;
  }
  #open(id: string): void {
    const version = this.#versions.get(id) ?? 0;
    const scheme = this.#options.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.#options.websocket(
      `${scheme}//${this.#options.location.host}/api/sessions/${encodeURIComponent(id)}/events?after=${this.#cursors.get(id) ?? 0}`,
    );
    this.#sockets.set(id, socket);
    socket.onmessage = (message) => {
      if (!this.#current(id, version) || this.#sockets.get(id) !== socket) return;
      try {
        this.#reconnectAttempts.delete(id);
        const data = JSON.parse(String(message.data)) as { type?: string; event?: Event };
        if (data.type === 'relay.resyncRequired') void this.resync(id);
        else if (data.type === 'relay.event' && data.event) this.observe(id, data.event);
      } catch {}
    };
    socket.onclose = () => {
      if (!this.#current(id, version) || this.#selected === id) return;
      this.#sockets.delete(id);
      this.#stale(id);
      const attempt = this.#reconnectAttempts.get(id) ?? 0;
      const delay = (this.#options.reconnectDelaysMs ?? [250, 1_000, 5_000])[attempt];
      if (delay === undefined) return;
      this.#reconnectAttempts.set(id, attempt + 1);
      this.#timers.set(
        id,
        this.#options.setTimeout(() => {
          this.#timers.delete(id);
          if (this.#current(id, version) && id !== this.#selected) this.#open(id);
        }, delay),
      );
    };
  }
  #apply(id: string, sequence: number, next: AgentActivitySnapshot): void {
    const previous = this.#snapshots.get(id);
    this.#cursors.set(id, Math.max(sequence, this.#cursors.get(id) ?? 0));
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.#snapshots.set(id, next);
    this.#options.publish(this.#snapshots);
  }
  #stale(id: string): void {
    const value = this.#snapshots.get(id);
    if (value && value.confidence === 'fresh') {
      this.#snapshots.set(id, { ...value, confidence: 'stale' });
      this.#options.publish(this.#snapshots);
    }
  }
}
