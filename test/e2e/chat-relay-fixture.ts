/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { BrowserContext, Page } from '@playwright/test';
import { chatSnapshot } from './chat-snapshot-fixture.js';

export type RelaySocket = { send(message: string): void; close(): void };
export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}>;
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export type DeferredCommandResponse =
  | Readonly<{ kind: 'fulfill'; status: number; body: unknown }>
  | Readonly<{ kind: 'abort'; errorCode?: string }>;
export type RecordedCommand = Readonly<{
  kind: 'turn' | 'interaction';
  sessionId: string;
  requestId?: string;
  body: unknown;
  idempotencyKey: string | null;
}>;
export type ProtocolCall = Readonly<{
  kind: 'history' | 'recentOpen' | 'resume' | 'turn';
  sessionId: string;
}>;
type RelayRouteHost =
  Pick<Page, 'route' | 'routeWebSocket'> | Pick<BrowserContext, 'route' | 'routeWebSocket'>;
export class ChatRelayFixture {
  readonly sockets = new Map<string, RelaySocket>();
  readonly socketGroups = new Map<string, Set<RelaySocket>>();
  readonly histories = new Map<string, ReturnType<typeof chatSnapshot>>();
  readonly historyDeferred = new Map<string, Deferred<ReturnType<typeof chatSnapshot>>>();
  readonly turns = new Map<string, Deferred<DeferredCommandResponse>>();
  readonly interactions = new Map<string, Deferred<DeferredCommandResponse>>();
  readonly commands: RecordedCommand[] = [];
  readonly protocol: ProtocolCall[] = [];
  readonly writerLocks = new Set<string>();
  readonly sessions: Array<Record<string, unknown>> = [];
  readonly recentSessions: Array<Record<string, unknown>> = [];
  readonly recentOpenSessions = new Map<string, Record<string, unknown>>();
  constructor(readonly page: RelayRouteHost) {}
  async install(sessions: Array<Record<string, unknown>>): Promise<void> {
    this.sessions.push(...sessions);
    await this.page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ workspaces: [], profiles: [], sessions: this.sessions }),
      }),
    );
    await this.page.route('**/api/sessions/recent-threads', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(this.recentSessions) }),
    );
    await this.page.route('**/api/sessions/recent-threads/open', async (route) => {
      const body = route.request().postDataJSON() as { threadId?: unknown };
      const threadId = typeof body.threadId === 'string' ? body.threadId : '';
      const session = this.recentOpenSessions.get(threadId);
      this.protocol.push({ kind: 'recentOpen', sessionId: threadId });
      if (!session) return route.fulfill({ status: 404 });
      if (!this.sessions.some((item) => item.id === session.id)) this.sessions.push(session);
      this.histories.set(
        String(session.id),
        this.histories.get(String(session.id)) ?? chatSnapshot(),
      );
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify(session),
      });
    });
    await this.page.route('**/api/sessions', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(this.sessions) }),
    );
    for (const session of sessions) this.histories.set(String(session.id), chatSnapshot());
    await this.page.route('**/api/sessions/*/history', async (route) => {
      const id = decodeURIComponent(route.request().url().split('/').at(-2) ?? '');
      this.protocol.push({ kind: 'history', sessionId: id });
      const pending = this.historyDeferred.get(id);
      if (pending && this.historyDeferred.get(id) === pending) this.historyDeferred.delete(id);
      const snapshot = pending ? await pending.promise : this.histories.get(id);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) });
    });
    await this.page.routeWebSocket(/\/api\/sessions\/([^/]+)\/events/, (socket) => {
      const id = decodeURIComponent(socket.url().split('/').at(-2) ?? '');
      this.sockets.set(id, socket);
      const group = this.socketGroups.get(id) ?? new Set<RelaySocket>();
      group.add(socket);
      this.socketGroups.set(id, group);
    });
    await this.page.route('**/api/sessions/*/turns', async (route) => {
      const id = decodeURIComponent(route.request().url().split('/').at(-2) ?? '');
      this.commands.push({
        kind: 'turn',
        sessionId: id,
        body: route.request().postDataJSON(),
        idempotencyKey: await route.request().headerValue('idempotency-key'),
      });
      if (this.writerLocks.has(id)) {
        await route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            code: 'SESSION_WRITER_BUSY',
            detail: 'This thread is active in another Codex client. Release it there, then retry.',
          }),
        });
        return;
      }
      this.protocol.push({ kind: 'resume', sessionId: id });
      this.protocol.push({ kind: 'turn', sessionId: id });
      const instruction = await this.turns.get(id)?.promise;
      if (!instruction || instruction.kind === 'abort') return route.abort(instruction?.errorCode);
      await route.fulfill({
        status: instruction.status,
        contentType: 'application/json',
        body: JSON.stringify(instruction.body),
      });
    });
    await this.page.route('**/api/sessions/*/interactions/*', async (route) => {
      const parts = route.request().url().split('/');
      const id = decodeURIComponent(parts.at(-3) ?? '');
      const requestId = decodeURIComponent(route.request().url().split('/').at(-1) ?? '');
      this.commands.push({
        kind: 'interaction',
        sessionId: id,
        requestId,
        body: route.request().postDataJSON(),
        idempotencyKey: await route.request().headerValue('idempotency-key'),
      });
      const instruction = await this.interactions.get(requestId)?.promise;
      if (!instruction || instruction.kind === 'abort') return route.abort(instruction?.errorCode);
      await route.fulfill({
        status: instruction.status,
        contentType: 'application/json',
        body: JSON.stringify(instruction.body),
      });
    });
  }
  snapshot(sessionId: string, snapshot: ReturnType<typeof chatSnapshot>): void {
    this.histories.set(sessionId, snapshot);
  }
  addRecent(recent: Record<string, unknown>, session: Record<string, unknown>): void {
    this.recentSessions.push(recent);
    this.recentOpenSessions.set(String(recent.id), session);
    this.histories.set(String(session.id), chatSnapshot());
  }
  event(
    sessionId: string,
    sequence: number,
    type: string,
    payload: unknown,
    occurredAt?: string,
  ): void {
    const message = JSON.stringify({
      type: 'relay.event',
      event: { sequence, type, payload, ...(occurredAt ? { occurredAt } : {}) },
    });
    for (const socket of this.socketGroups.get(sessionId) ?? []) {
      try {
        socket.send(message);
      } catch {
        // A multi-page fixture can retain a route after its page has closed.
      }
    }
  }
  duplicate(sessionId: string, sequence: number, type: string, payload: unknown): void {
    this.event(sessionId, sequence, type, payload);
    this.event(sessionId, sequence, type, payload);
  }
  gap(sessionId: string, sequence: number, type: string, payload: unknown): void {
    this.event(sessionId, sequence, type, payload);
  }
  close(sessionId: string): void {
    for (const socket of this.socketGroups.get(sessionId) ?? []) socket.close();
  }
  deferHistory(sessionId: string): Deferred<ReturnType<typeof chatSnapshot>> {
    const value = deferred<ReturnType<typeof chatSnapshot>>();
    this.historyDeferred.set(sessionId, value);
    return value;
  }
  deferTurn(sessionId: string): Deferred<DeferredCommandResponse> {
    const value = deferred<DeferredCommandResponse>();
    this.turns.set(sessionId, value);
    return value;
  }
  deferInteraction(requestId: string): Deferred<DeferredCommandResponse> {
    const value = deferred<DeferredCommandResponse>();
    this.interactions.set(requestId, value);
    return value;
  }
  lockWriter(sessionId: string): void {
    this.writerLocks.add(sessionId);
  }
  releaseWriter(sessionId: string): void {
    this.writerLocks.delete(sessionId);
  }
}
