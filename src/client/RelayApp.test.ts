/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

let controllerOptions: {
  publish(view: unknown): void;
  onSendError?(error: unknown, operationId: string): void;
  onSendAccepted?(sessionId: string, operationId: string): void;
  onHistoryPromptAccepted?(sessionId: string, operationId: string): void;
  onSessionEvent?(event: unknown): void;
} | null = null;
let fakeController: {
  selected: string | null;
  select(id: string | null): void;
  emit(id: string, view: unknown): void;
  failSend(error: unknown, operationId: string): void;
  acceptSend(operationId: string): void;
  metadata(id: string, event: unknown): void;
} | null = null;
let activityOptions: { publish(items: ReadonlyMap<string, unknown>): void } | null = null;
let submittedOperationId: string | null = null;
let submittedSessionId: string | null = null;
let submittedKind: 'send' | 'queue' | 'interrupt-send' | null = null;
let rejectAcceptedDraftConsume = false;
const controllerCalls = vi.hoisted(() => ({ send: 0, queue: 0, interruptAndSend: 0 }));
type CachedDraft = {
  text: string;
  revision: number;
  pending?: Array<{ operationId: string; text: string; revision: number; kind: string }>;
};
const cachedDrafts = vi.hoisted(() => new Map<string, CachedDraft>());
vi.mock('./features/sessions/session-cache.js', () => ({
  createSessionCache: () => ({
    readSelectedSession: async () => null,
    saveSelectedSession: async () => {},
    readDraft: async (id: string) => cachedDrafts.get(id)?.text ?? '',
    saveDraft: async (id: string, text: string) => {
      const current = cachedDrafts.get(id)?.revision ?? 0;
      cachedDrafts.set(id, { text, revision: current + 1 });
    },
    readDraftEnvelope: async (id: string) => cachedDrafts.get(id) ?? { text: '', revision: 0 },
    saveDraftEnvelope: async (id: string, draft: { text: string; revision: number }) => {
      cachedDrafts.set(id, draft);
    },
    replaceDraftText: async (id: string, text: string, revision: number) => {
      cachedDrafts.set(id, { ...(cachedDrafts.get(id) ?? {}), text, revision });
    },
    addPendingDraftOperation: async (
      id: string,
      operation: NonNullable<CachedDraft['pending']>[number],
    ) => {
      const current = cachedDrafts.get(id) ?? { text: '', revision: 0 };
      cachedDrafts.set(id, {
        ...current,
        pending: [
          ...(current.pending ?? []).filter((entry) => entry.operationId !== operation.operationId),
          operation,
        ],
      });
    },
    consumeAcceptedDraft: async (id: string, revision: number, operationId: string) => {
      if (rejectAcceptedDraftConsume) return null;
      const current = cachedDrafts.get(id) ?? { text: '', revision: 0 };
      if (
        current.revision !== revision ||
        !current.pending?.some((entry) => entry.operationId === operationId)
      )
        return null;
      const consumed = {
        text: '',
        revision: revision + 1,
        pending: current.pending.filter((entry) => entry.operationId !== operationId),
      };
      cachedDrafts.set(id, consumed);
      return consumed;
    },
    readCursor: async () => 0,
    saveCursor: async () => {},
  }),
}));
vi.mock('./features/agent-activity/agent-activity-controller.js', () => ({
  AgentActivityController: class {
    constructor(options: typeof activityOptions) {
      activityOptions = options;
    }
    bootstrap = vi.fn();
    sync = vi.fn();
    select = vi.fn();
    observe = vi.fn();
    dispose = vi.fn();
  },
}));
const originalScrollIntoView = Element.prototype.scrollIntoView;
vi.mock('./features/chat/chat-controller.js', () => ({
  ChatController: class {
    selected: string | null = null;
    constructor(options: typeof controllerOptions) {
      controllerOptions = options;
      fakeController = {
        selected: null,
        select: (id) => {
          if (!fakeController) return;
          fakeController.selected = id;
          controllerOptions?.publish(id ? chatView(id, '') : null);
        },
        emit: (id, view) => {
          if (id === fakeController?.selected) controllerOptions?.publish(view);
        },
        failSend: (error, operationId) => controllerOptions?.onSendError?.(error, operationId),
        acceptSend: (operationId) =>
          controllerOptions?.onSendAccepted?.(submittedSessionId ?? '', operationId),
        metadata: (id, event) => {
          if (id === fakeController?.selected) controllerOptions?.onSessionEvent?.(event);
        },
      };
    }
    select = (id: string | null) => {
      this.selected = id;
      fakeController?.select(id);
    };
    emit = (id: string, view: unknown) => {
      fakeController?.emit(id, view);
    };
    refresh = vi.fn();
    canSubmit = vi.fn(() => true);
    dispose = vi.fn();
    send = vi.fn((_text: string, operationId: string) => {
      controllerCalls.send += 1;
      submittedOperationId = operationId;
      submittedSessionId = this.selected;
      submittedKind = 'send';
    });
    queue = vi.fn((_text: string, operationId: string) => {
      controllerCalls.queue += 1;
      submittedOperationId = operationId;
      submittedSessionId = this.selected;
      submittedKind = 'queue';
    });
    interruptAndSend = vi.fn((_text: string, operationId: string) => {
      controllerCalls.interruptAndSend += 1;
      submittedOperationId = operationId;
      submittedSessionId = this.selected;
      submittedKind = 'interrupt-send';
    });
    interrupt = vi.fn();
    respond = vi.fn();
  },
}));

import RelayApp from './RelayApp.svelte';

const chatView = (id: string, text: string) => ({
  sessionId: id,
  cursor: 0,
  snapshotting: false,
  lifecycle: 'finished' as const,
  activeTurnId: null,
  messages: [{ id: `item:${id}`, role: 'assistant' as const, text, complete: true }],
  activities: [],
  prompts: [],
  interactions: [],
  buffered: new Map(),
  status: 'Ready.',
  starting: false,
});

async function renderChat(
  initialSessions = [
    { id: 'a', state: 'ready', workspacePath: '/a' },
    { id: 'b', state: 'ready', workspacePath: '/b' },
  ],
): Promise<HTMLTextAreaElement> {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  render(RelayApp, {
    authorizedFetch: async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(input) === '/api/bootstrap'
            ? { workspaces: [], profiles: [], models: [], sessions: initialSessions }
            : [],
        ),
      ),
    passkeyAuthEnabled: false,
    theme: 'minimal-dark',
    onlock: vi.fn(),
  });
  await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
  await fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
  return screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
}

describe('RelayApp chat controller composition', () => {
  afterEach(() => {
    cleanup();
    controllerOptions = null;
    fakeController = null;
    activityOptions = null;
    submittedOperationId = null;
    submittedSessionId = null;
    submittedKind = null;
    rejectAcceptedDraftConsume = false;
    controllerCalls.send = 0;
    controllerCalls.queue = 0;
    controllerCalls.interruptAndSend = 0;
    cachedDrafts.clear();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
    if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
  it('retains a submitted draft until its matching relay acceptance, without erasing a newer edit', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    render(RelayApp, {
      authorizedFetch: async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: [],
                  sessions: [
                    { id: 'a', state: 'ready', workspacePath: '/a' },
                    { id: 'b', state: 'ready', workspacePath: '/b' },
                  ],
                }
              : [],
          ),
        ),
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
    await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
    await fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
    await fireEvent.input(prompt, { target: { value: 'private instruction' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    expect(prompt.value).toBe('private instruction');
    fakeController?.acceptSend('missing-operation');
    expect(prompt.value).toBe('private instruction');
    // The production controller reports the generated operation ID. Obtain it from its optimistic view.
    expect(submittedOperationId).not.toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /Sessions/i }));
    const sessionB = screen.getByText('/b').closest('li')!;
    await fireEvent.click(within(sessionB).getByRole('button', { name: 'Open' }));
    await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
    fakeController?.acceptSend(submittedOperationId!);
    await vi.waitFor(() => expect(cachedDrafts.get('a')?.text).toBe(''));
  });
  it('clears a matching acknowledgement exactly once, but preserves an edit made before it', async () => {
    const prompt = await renderChat();
    await fireEvent.input(prompt, { target: { value: 'first instruction' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    const operationId = submittedOperationId!;
    await fireEvent.input(prompt, { target: { value: 'newer instruction' } });
    fakeController?.acceptSend(operationId);
    await vi.waitFor(() => expect(cachedDrafts.get('a')?.text).toBe('newer instruction'));
    expect(prompt.value).toBe('newer instruction');
    fakeController?.acceptSend(operationId);
    await Promise.resolve();
    expect(cachedDrafts.get('a')).toMatchObject({ text: 'newer instruction', revision: 2 });
  });
  it('submits one relay call for a revision, retains failed text, and retries with the same ID', async () => {
    const prompt = await renderChat();
    await fireEvent.input(prompt, { target: { value: 'exact failed instruction' } });
    const send = screen.getByRole('button', { name: 'Send prompt' });
    await fireEvent.click(send);
    await fireEvent.click(send);
    const operationId = submittedOperationId!;
    expect(controllerCalls.send).toBe(1);
    fakeController?.failSend(new Error('offline'), operationId);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Retry send' })).toBeTruthy());
    expect(prompt.value).toBe('exact failed instruction');
    await fireEvent.click(screen.getByRole('button', { name: 'Retry send' }));
    expect(controllerCalls.send).toBe(2);
    expect(submittedOperationId).toBe(operationId);
  });
  it('restores a pending draft and accepts it from authoritative history without another relay call', async () => {
    cachedDrafts.set('a', {
      text: 'recovered instruction',
      revision: 7,
      pending: [
        { operationId: 'recovered-op', text: 'recovered instruction', revision: 7, kind: 'send' },
      ],
    });
    const prompt = await renderChat();
    await vi.waitFor(() => expect(prompt.value).toBe('recovered instruction'));
    controllerOptions?.onHistoryPromptAccepted?.('a', 'recovered-op');
    await vi.waitFor(() => expect(cachedDrafts.get('a')?.text).toBe(''));
    expect(controllerCalls.send).toBe(0);
  });
  it('preserves text and reuses the operation ID when acceptance cannot be consumed locally', async () => {
    const prompt = await renderChat();
    await fireEvent.input(prompt, { target: { value: 'retain after cache failure' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
    const operationId = submittedOperationId!;
    rejectAcceptedDraftConsume = true;
    fakeController?.acceptSend(operationId);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Retry send' })).toBeTruthy());
    expect(prompt.value).toBe('retain after cache failure');
    await fireEvent.click(screen.getByRole('button', { name: 'Retry send' }));
    expect(submittedOperationId).toBe(operationId);
  });
  it('keeps queue and interrupt-send drafts until their own acknowledgement', async () => {
    const prompt = await renderChat();
    fakeController?.emit('a', { ...chatView('a', ''), activeTurnId: 'turn-a' });
    await fireEvent.input(prompt, { target: { value: 'queued instruction' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Choose prompt action' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    const queueOperation = submittedOperationId!;
    expect(submittedKind).toBe('queue');
    expect(prompt.value).toBe('queued instruction');
    fakeController?.acceptSend(queueOperation);
    await vi.waitFor(() => expect(prompt.value).toBe(''));

    await fireEvent.input(prompt, { target: { value: 'interrupt instruction' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Choose prompt action' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send' }));
    const interruptOperation = submittedOperationId!;
    expect(submittedKind).toBe('interrupt-send');
    expect(prompt.value).toBe('interrupt instruction');
    fakeController?.acceptSend(interruptOperation);
    await vi.waitFor(() => expect(prompt.value).toBe(''));
  });
  it('pins a detached Chat window to its URL session without rendering app navigation', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState({}, '', '/?chat-session=b');
    const authorizedFetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: [],
                  sessions: [
                    { id: 'a', state: 'ready', workspacePath: '/work/a' },
                    { id: 'b', state: 'ready', workspacePath: '/work/b', model: 'gpt-5.6-sol' },
                  ],
                }
              : [],
          ),
        ),
    );

    render(RelayApp, {
      authorizedFetch,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });

    await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
    fakeController?.emit('b', chatView('b', 'session B'));
    await vi.waitFor(() => expect(screen.getByText('session B')).toBeTruthy());
    expect(screen.getByText('/work/b')).toBeTruthy();
    expect(screen.getByText('gpt-5.6-sol')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open configuration' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Chat in a separate window' })).toBeNull();
  });

  it('accepts a valid status only from the currently subscribed session and ignores malformed or late events', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    const authorizedFetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: [],
                  sessions: [
                    { id: 'a', state: 'ready', workspacePath: '/work/a' },
                    { id: 'b', state: 'ready', workspacePath: '/work/b' },
                  ],
                }
              : [],
          ),
        ),
    );
    render(RelayApp, {
      authorizedFetch,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
    await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
    const valid = {
      type: 'session.status.updated',
      sequence: 1,
      payload: {
        state: 'idle',
        reason: 'incompleteWithoutContinuation',
        confidence: 'fresh',
        observedAt: '2026-09-13T12:00:00.000Z',
        nextExpectedAction: 'Resume.',
      },
    };
    fakeController?.metadata('a', valid);
    await vi.waitFor(() => expect(screen.getByText('Idle')).toBeTruthy());
    fakeController?.metadata('a', { ...valid, sequence: 2, payload: { state: 'working' } });
    expect(screen.getByText('Idle')).toBeTruthy();
    fakeController?.select('b');
    fakeController?.metadata('a', valid);
    expect(screen.queryByText('Resume.')).toBeNull();
  });

  it('opens a named window for the selected Chat session', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    const detachedWindow = { opener: window, focus: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(detachedWindow as unknown as Window);
    const authorizedFetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: [],
                  sessions: [{ id: 'a', state: 'ready', workspacePath: '/work/a' }],
                }
              : String(input) === '/api/skill-profiles'
                ? { profiles: [] }
                : [],
          ),
        ),
    );
    render(RelayApp, {
      authorizedFetch,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
    await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
    await fireEvent.click(screen.getByRole('button', { name: 'Chat' }));

    await fireEvent.click(screen.getByRole('button', { name: 'Open Chat in a separate window' }));

    expect(open).toHaveBeenCalledOnce();
    const [url, name, features] = open.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get('chat-session')).toBe('a');
    expect(name).toMatch(/^gestalt-chat-/);
    expect(features).toBe('popup,width=760,height=900');
    expect(detachedWindow.opener).toBeNull();
    expect(detachedWindow.focus).toHaveBeenCalledOnce();
  });
  it('renders controller view after session switch and ignores late old-session content', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    const authorizedFetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: [],
                  sessions: [
                    { id: 'a', state: 'ready', workspacePath: '/work/a' },
                    { id: 'b', state: 'ready', workspacePath: '/work/b' },
                  ],
                }
              : String(input) === '/api/skill-profiles'
                ? { profiles: [] }
                : [],
          ),
        ),
    );
    render(RelayApp, {
      authorizedFetch,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
    await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
    fakeController?.emit('a', chatView('a', 'session A'));
    screen.getByRole('button', { name: 'Chat' }).click();
    await vi.waitFor(() => expect(screen.getByText('session A')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: /Sessions/i }));
    await vi.waitFor(() =>
      expect(screen.getByRole('heading', { name: /Open sessions/i })).toBeTruthy(),
    );
    const sessionB = screen.getByText('/work/b').closest('li')!;
    await fireEvent.click(within(sessionB).getByRole('button', { name: 'Open' }));
    await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
    expect(screen.queryByText('session A')).toBeNull();
    fakeController?.emit('a', chatView('a', 'late A'));
    expect(screen.queryByText('late A')).toBeNull();
    fakeController?.emit('b', chatView('b', 'session B'));
    screen.getByRole('button', { name: 'Chat' }).click();
    await vi.waitFor(() => expect(screen.getByText('session B')).toBeTruthy());
  });
  it('projects one activity map to both Chat and Sessions without cross-session content', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: [],
                  sessions: [
                    { id: 'a', state: 'ready', workspacePath: '/a' },
                    { id: 'b', state: 'ready', workspacePath: '/b' },
                  ],
                }
              : String(input) === '/api/skill-profiles'
                ? { profiles: [] }
                : [],
          ),
        ),
    );
    render(RelayApp, {
      authorizedFetch: fetcher,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
    await vi.waitFor(() => expect(activityOptions).not.toBeNull());
    activityOptions?.publish(
      new Map([
        [
          'a',
          {
            sessionId: 'a',
            confidence: 'fresh',
            aggregateSubagents: 'idle',
            root: {
              state: 'working',
              observedAt: '2026-01-01T00:00:00.000Z',
              lastActivityAt: '2026-01-01T00:00:00.000Z',
            },
            subagents: [],
          },
        ],
      ]),
    );
    await fireEvent.click(screen.getByRole('button', { name: /Sessions/i }));
    await vi.waitFor(() => expect(screen.getByText('/a')).toBeTruthy());
    const sessionA = screen.getByText('/a').closest('li')!;
    const sessionB = screen.getByText('/b').closest('li')!;
    await vi.waitFor(() => expect(sessionA.textContent).toContain('working'));
    expect(sessionA.textContent).not.toContain('activity unavailable');
    expect(sessionB.textContent).toContain('activity unavailable');
    await fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    await vi.waitFor(() => expect(screen.getByText('Agents (1)')).toBeTruthy());
    expect(screen.getByText('Supervisor')).toBeTruthy();
    expect(screen.getByText(/working · active/)).toBeTruthy();
    expect(screen.queryByText('activity unavailable')).toBeNull();
  });

  it('warns once without persistent retry UI when a session workspace is unavailable', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    const authorizedFetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: [],
                  sessions: [{ id: 'a', state: 'ready', workspacePath: '/work/a' }],
                }
              : String(input) === '/api/skill-profiles'
                ? { profiles: [] }
                : [],
          ),
        ),
    );
    render(RelayApp, {
      authorizedFetch,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
    await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
    await fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fakeController?.emit('a', {
      ...chatView('a', ''),
      messages: [
        {
          id: 'prompt:send-1',
          role: 'user',
          text: 'Keep this message available',
          complete: false,
        },
      ],
      prompts: [
        {
          operationId: 'send-1',
          key: 'prompt:send-1',
          text: 'Keep this message available',
          state: 'failed',
        },
      ],
    });
    fakeController?.failSend(
      Object.assign(new Error('workspace unavailable'), {
        code: 'SESSION_WORKSPACE_UNAVAILABLE',
        retryable: true,
      }),
      'send-1',
    );

    expect(await screen.findByText('Keep this message available')).toBeTruthy();
    const warningCopy = await screen.findByText(
      /Your message remains in the conversation for copying/,
    );
    const warning = warningCopy.closest('[role="status"]');
    expect(warning).not.toBeNull();
    expect(warning?.classList.contains('warning')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Retry send' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
