/* Copyright (C) 2026 Dyne.org foundation SPDX-License-Identifier: AGPL-3.0-or-later */
import type { Page } from '@playwright/test';
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
export class ChatRelayFixture {
  readonly sockets = new Map<string, RelaySocket>();
  readonly histories = new Map<string, ReturnType<typeof chatSnapshot>>();
  readonly historyDeferred = new Map<string, Deferred<ReturnType<typeof chatSnapshot>>>();
  readonly turns = new Map<string, Deferred<DeferredCommandResponse>>();
  readonly interactions = new Map<string, Deferred<DeferredCommandResponse>>();
  readonly commands: RecordedCommand[] = [];
  constructor(readonly page: Page) {}
  async install(sessions: Array<Record<string, unknown>>): Promise<void> {
    await this.page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ workspaces: [], profiles: [], sessions }),
      }),
    );
    await this.page.route('**/api/sessions/recent-threads', (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' }),
    );
    for (const session of sessions) {
      const id = String(session.id);
      this.histories.set(id, chatSnapshot());
      await this.page.route(`**/api/sessions/${id}/history`, async (route) => {
        const pending = this.historyDeferred.get(id);
        if (pending && this.historyDeferred.get(id) === pending) this.historyDeferred.delete(id);
        const snapshot = pending ? await pending.promise : this.histories.get(id);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) });
      });
      await this.page.routeWebSocket(new RegExp(`/api/sessions/${id}/events`), (socket) =>
        this.sockets.set(id, socket),
      );
      await this.page.route(`**/api/sessions/${id}/turns`, async (route) => {
        this.commands.push({
          kind: 'turn',
          sessionId: id,
          body: route.request().postDataJSON(),
          idempotencyKey: await route.request().headerValue('idempotency-key'),
        });
        const instruction = await this.turns.get(id)?.promise;
        if (!instruction || instruction.kind === 'abort')
          return route.abort(instruction?.errorCode);
        await route.fulfill({
          status: instruction.status,
          contentType: 'application/json',
          body: JSON.stringify(instruction.body),
        });
      });
      await this.page.route(`**/api/sessions/${id}/interactions/*`, async (route) => {
        const requestId = decodeURIComponent(route.request().url().split('/').at(-1) ?? '');
        this.commands.push({
          kind: 'interaction',
          sessionId: id,
          requestId,
          body: route.request().postDataJSON(),
          idempotencyKey: await route.request().headerValue('idempotency-key'),
        });
        const instruction = await this.interactions.get(requestId)?.promise;
        if (!instruction || instruction.kind === 'abort')
          return route.abort(instruction?.errorCode);
        await route.fulfill({
          status: instruction.status,
          contentType: 'application/json',
          body: JSON.stringify(instruction.body),
        });
      });
    }
  }
  snapshot(sessionId: string, snapshot: ReturnType<typeof chatSnapshot>): void {
    this.histories.set(sessionId, snapshot);
  }
  event(sessionId: string, sequence: number, type: string, payload: unknown): void {
    this.sockets
      .get(sessionId)
      ?.send(JSON.stringify({ type: 'relay.event', event: { sequence, type, payload } }));
  }
  duplicate(sessionId: string, sequence: number, type: string, payload: unknown): void {
    this.event(sessionId, sequence, type, payload);
    this.event(sessionId, sequence, type, payload);
  }
  gap(sessionId: string, sequence: number, type: string, payload: unknown): void {
    this.event(sessionId, sequence, type, payload);
  }
  close(sessionId: string): void {
    this.sockets.get(sessionId)?.close();
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
}
