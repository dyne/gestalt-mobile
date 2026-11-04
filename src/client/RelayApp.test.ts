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
  onConnectionChange?(connected: boolean): void;
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
    hydrate = vi.fn(async () => {});
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
import { NOTIFICATION_HISTORY_STORAGE_KEY } from './features/feedback/toast-queue.js';
import type { SessionForgetOperation } from '../shared/contracts/session-forget.js';
import type { CleanTmpResult } from '../shared/contracts/tmp-cleanup.js';
import type { SupervisedPlan } from './features/plans/contracts.js';

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
  initialSessions: Array<{
    id: string;
    state: string;
    workspacePath: string;
    resumeCommand?: string;
  }> = [
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
            ? {
                workspaces: [],
                profiles: [],
                models: { codex: [], kimi: [] },
                sessions: initialSessions,
              }
            : String(input) === '/api/sessions'
              ? initialSessions
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
  function planRaceFixture() {
    const plan = (title: string): SupervisedPlan => ({
      title,
      steps: [],
      totalSteps: 1,
      doneSteps: 0,
      allDone: false,
      currentStepId: 'work',
    });
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const roster = [
      { id: 'a', state: 'ready', workspacePath: '/a', threadId: 'thread-a' },
      { id: 'b', state: 'ready', workspacePath: '/b', threadId: 'thread-b' },
    ];
    const reads = { a: deferred<SupervisedPlan | null>(), b: deferred<SupervisedPlan | null>() };
    const lists: Array<ReturnType<typeof deferred<Array<Record<string, unknown>>>>> = [];
    let listRevision = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === '/api/sessions') {
        const read = deferred<Array<Record<string, unknown>>>();
        lists.push(read);
        return new Response(JSON.stringify(await read.promise));
      }
      if (path === '/api/sessions/a/plan' || path === '/api/sessions/b/plan') {
        const value = await reads[path.includes('/a/') ? 'a' : 'b'].promise;
        return value ? new Response(JSON.stringify(value)) : new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify(
          path === '/api/bootstrap'
            ? { workspaces: [], profiles: [], models: { codex: [], kimi: [] }, sessions: roster }
            : path === '/api/skill-profiles'
              ? { profiles: [] }
              : [],
        ),
      );
    });
    const view = render(RelayApp, {
      authorizedFetch: fetcher,
      passkeyAuthEnabled: false,
      theme: 'dyne-org',
      onlock: vi.fn(),
    });
    return {
      plan,
      roster,
      reads,
      lists,
      fetcher,
      row: (id: string) => document.querySelector(`[data-session-id="${id}"]`) as HTMLElement,
      reconnect: () => {
        controllerOptions?.onConnectionChange?.(true);
        return lists.at(-1)!;
      },
      finishList: async (read: (typeof lists)[number], rows: Array<Record<string, unknown>>) => {
        const marker = `/observed-list-${++listRevision}`;
        read.resolve(
          rows.map((row) => ({ ...row, workspacePath: `${row.workspacePath}${marker}` })),
        );
        await vi.waitFor(() =>
          expect(document.querySelector('[data-session-id="a"]')?.textContent).toContain(marker),
        );
      },
      dispose: () => {
        view.unmount();
        reads.a.resolve(null);
        reads.b.resolve(null);
        lists.forEach((read) => read.resolve(roster));
      },
    };
  }

  it('keeps the initial selected plan and Agents control when a delayed reconnect roster arrives afterwards', async () => {
    const f = planRaceFixture();
    try {
      await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
      const list = f.reconnect();
      f.reads.a.resolve(f.plan('Initially loaded plan'));
      await vi.waitFor(() =>
        expect(
          f.row('a').querySelector('.session-plan-progress progress')?.getAttribute('aria-label'),
        ).toContain('Initially loaded plan'),
      );
      expect(f.row('a').querySelector('.agents')).not.toBeNull();
      await f.finishList(list, f.roster);
      await vi.waitFor(() =>
        expect(
          f.row('a').querySelector('.session-plan-progress progress')?.getAttribute('aria-label'),
        ).toContain('Initially loaded plan'),
      );
      expect(f.row('a').querySelector('.agents')).not.toBeNull();
      expect(f.row('b').querySelector('.session-plan-progress')).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('keeps explicit plan absence and accepted detach through stale rosters and rejects older socket plan replays', async () => {
    const f = planRaceFixture();
    try {
      await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
      f.reads.a.resolve(null);
      await vi.waitFor(() => expect(f.row('a').querySelector('.agents')).toBeNull());
      const first = f.reconnect();
      await f.finishList(
        first,
        f.roster.map((row) =>
          row.id === 'a' ? { ...row, plan: f.plan('Stale roster plan') } : row,
        ),
      );
      await vi.waitFor(() => expect(f.row('a').querySelector('.session-plan-progress')).toBeNull());
      fakeController?.metadata('a', {
        sequence: 10,
        type: 'plan.updated',
        payload: { plan: f.plan('Newer socket plan'), reason: null },
      });
      await vi.waitFor(() =>
        expect(
          f.row('a').querySelector('.session-plan-progress progress')?.getAttribute('aria-label'),
        ).toContain('Newer socket plan'),
      );
      fakeController?.metadata('a', {
        sequence: 9,
        type: 'plan.updated',
        payload: f.plan('Rejected replay'),
      });
      const newer = f.reconnect();
      await f.finishList(newer, f.roster);
      await vi.waitFor(() =>
        expect(
          f.row('a').querySelector('.session-plan-progress progress')?.getAttribute('aria-label'),
        ).toContain('Newer socket plan'),
      );
      fakeController?.metadata('a', { sequence: 11, type: 'plan.closed', payload: {} });
      await vi.waitFor(() => expect(f.row('a').querySelector('.agents')).toBeNull());
      fakeController?.metadata('a', {
        sequence: 10,
        type: 'plan.updated',
        payload: f.plan('Rejected resurrection'),
      });
      const detached = f.reconnect();
      await f.finishList(
        detached,
        f.roster.map((row) =>
          row.id === 'a'
            ? {
                ...row,
                plan: f.plan('Stale attached plan'),
                lastOrgPlan: { filename: 'old.org', title: 'Old plan', attached: true },
              }
            : row,
        ),
      );
      await vi.waitFor(() => expect(f.row('a').querySelector('.agents')).toBeNull());
      expect(f.row('a').querySelector('.session-plan-progress')).toBeNull();
      expect(f.row('a').textContent).not.toContain('Org plan attached');
    } finally {
      f.dispose();
    }
  });

  it('does not publish a late initial plan into a newly selected session or erase the selected session plan with a list', async () => {
    const f = planRaceFixture();
    try {
      await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
      await fireEvent.click(within(f.row('b')).getByRole('button', { name: /^Open$/ }));
      await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
      await fireEvent.click(screen.getByRole('button', { name: /^Sessions$/ }));
      f.reads.b.resolve(f.plan('Selected B plan'));
      f.reads.a.resolve(f.plan('Late A plan'));
      f.lists.slice(0, -1).forEach((list) => list.resolve(f.roster));
      await f.finishList(f.lists.at(-1)!, f.roster);
      await vi.waitFor(() =>
        expect(
          f.row('b').querySelector('.session-plan-progress progress')?.getAttribute('aria-label'),
        ).toContain('Selected B plan'),
      );
      expect(f.row('a').querySelector('.session-plan-progress')).toBeNull();
      expect(f.row('b').textContent).not.toContain('Late A plan');
      expect(fakeController?.selected).toBe('b');
    } finally {
      f.dispose();
    }
  });
  function cleanupFixture() {
    let release!: (value: Response) => void;
    const replies: Promise<Response>[] = [];
    const defer = () =>
      replies.push(
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      );
    defer();
    const roster = [
      { id: 'a', state: 'ready', workspacePath: '/a' },
      { id: 'b', state: 'ready', workspacePath: '/b' },
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/maintenance/clean-tmp' && init?.method === 'POST') return replies.shift()!;
      return new Response(
        JSON.stringify(
          path === '/api/bootstrap'
            ? { workspaces: [], profiles: [], models: { codex: [], kimi: [] }, sessions: roster }
            : path === '/api/sessions'
              ? roster
              : path === '/api/skill-profiles'
                ? { profiles: [] }
                : [],
        ),
      );
    });
    render(RelayApp, {
      authorizedFetch: fetcher,
      passkeyAuthEnabled: false,
      theme: 'dyne-org',
      onlock: vi.fn(),
    });
    return { fetcher, finish: (response: Response) => release(response), defer };
  }

  it.each(['complete', 'partial'] as const)(
    'keeps another session usable through delayed Clean TMP and reports %s counts in the shared toast',
    async (status) => {
      const f = cleanupFixture();
      await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
      const menu = within(document.getElementById('configuration-panel')!);
      const action = menu.getByRole('button', {
        name: /^Clean TMP$/,
        hidden: true,
      }) as HTMLButtonElement;
      action.click();
      action.click();
      await vi.waitFor(() => expect(action.disabled).toBe(true));
      expect(
        f.fetcher.mock.calls.filter(([path]) => String(path) === '/api/maintenance/clean-tmp'),
      ).toHaveLength(1);
      expect(action.getAttribute('aria-busy')).toBe('true');
      await fireEvent.click(screen.getByRole('button', { name: /^Sessions$/ }));
      await fireEvent.click(
        within(screen.getByRole('list', { name: 'Open sessions' })).getAllByRole('button', {
          name: /^Open$/,
        })[1]!,
      );
      await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
      const result: CleanTmpResult = {
        status,
        folders: { removed: 2, skipped: 3, failed: status === 'partial' ? 1 : 0 },
        workspaces: {
          cleaned: 0,
          removed: 2,
          skipped: 2,
          failed: status === 'partial' ? 1 : 0,
          unavailable: 0,
        },
        reasons: {
          protected: 2,
          busy: 0,
          lease: 0,
          unrecognized: 1,
          unsafe: 0,
          unavailable: 0,
          io: status === 'partial' ? 1 : 0,
        },
      };
      f.finish(new Response(JSON.stringify(result)));
      await vi.waitFor(() => expect(action.disabled).toBe(false));
      const toast = document.querySelector('.toast')!;
      expect(document.querySelectorAll('.toast')).toHaveLength(1);
      expect(toast.getAttribute('role')).toBe(status === 'partial' ? 'alert' : 'status');
      expect(toast.textContent).toContain(
        'Removed 2 temporary folders in 2 workspaces. Kept 2 protected folders. Skipped 1 other folder.',
      );
      if (status === 'partial')
        expect(toast.textContent).toContain('Could not remove 1 folder. Try Clean TMP again.');
      expect(fakeController?.selected).toBe('b');
    },
  );

  it('restores cleanup controls after a shared request error and permits a truthful empty retry', async () => {
    const f = cleanupFixture();
    await vi.waitFor(() => expect(fakeController?.selected).toBe('a'));
    const action = within(document.getElementById('configuration-panel')!).getByRole('button', {
      name: /^Clean TMP$/,
      hidden: true,
    }) as HTMLButtonElement;
    action.click();
    f.finish(
      new Response(
        JSON.stringify({ code: 'TMP_CLEANUP_UNAVAILABLE', detail: 'private filesystem details' }),
        { status: 503 },
      ),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Temporary files could not be checked. Try Clean TMP again.',
      ),
    );
    expect(action.disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).not.toContain('private');
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss error notification' }));
    f.defer();
    action.click();
    f.finish(
      new Response(
        JSON.stringify({
          status: 'complete',
          folders: { removed: 0, skipped: 0, failed: 0 },
          workspaces: { cleaned: 2, removed: 0, skipped: 0, failed: 0, unavailable: 0 },
          reasons: {
            protected: 0,
            busy: 0,
            lease: 0,
            unrecognized: 0,
            unsafe: 0,
            unavailable: 0,
            io: 0,
          },
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('.toast')?.textContent).toContain(
        'No temporary folders to remove.',
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      f.fetcher.mock.calls.filter(([path]) => String(path) === '/api/maintenance/clean-tmp'),
    ).toHaveLength(2);
  });
  function forgettingFixture(initialPhase?: SessionForgetOperation['phase']) {
    const owner = {
      id: 'a',
      state: 'released',
      threadId: 'thread-a',
      workspacePath: '/forget-me',
      resumeCommand: 'codex resume thread-a',
    };
    const other = {
      id: 'b',
      state: 'ready',
      threadId: 'thread-b',
      workspacePath: '/other-session',
    };
    let phase = initialPhase;
    let removed = false;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const operation = (): SessionForgetOperation | undefined =>
      phase
        ? {
            operationId: 'durable-forget',
            sessionId: owner.id,
            phase,
            updatedAt: '2026-11-04T10:00:00.000Z',
            ...(phase === 'failed' ? { failureCode: 'SESSION_CLEANUP_FAILED' as const } : {}),
          }
        : undefined;
    const roster = () => [...(removed ? [] : [{ ...owner, forgetOperation: operation() }]), other];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        if (path === '/api/sessions/a' && init?.method === 'DELETE') {
          phase = 'stopping';
          return pending;
        }
        return new Response(
          JSON.stringify(
            path === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: { codex: [], kimi: [] },
                  sessions: roster(),
                }
              : path === '/api/sessions'
                ? roster()
                : path === '/api/sessions/a'
                  ? { ...owner, forgetOperation: operation() }
                  : path === '/api/skill-profiles'
                    ? { profiles: [] }
                    : [],
          ),
        );
      },
    );
    const view = render(RelayApp, {
      authorizedFetch: fetcher,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
    return {
      view,
      fetcher,
      release,
      phase: (next: NonNullable<typeof phase>) => {
        phase = next;
        fakeController?.metadata('a', {
          sequence: 1,
          type: 'session.forget.updated',
          payload: operation(),
        });
      },
      finish: () => {
        removed = true;
        release(new Response(null, { status: 204 }));
      },
    };
  }

  it('renders immediately through delayed stop/deletion, prevents duplicate forgets and keeps another session usable until history placement', async () => {
    const f = forgettingFixture();
    try {
      await vi.waitFor(() => expect(screen.getByRole('button', { name: /^Forget$/ })).toBeTruthy());
      const row = () => document.querySelector('[data-session-id="a"]') as HTMLElement;
      const forget = within(row()).getByRole('button', { name: /^Forget$/ });
      await fireEvent.click(forget);
      expect(row().getAttribute('aria-busy')).toBe('true');
      expect(within(row()).getByRole('status').textContent).toContain('Forgetting session…');
      await fireEvent.click(forget);
      expect(
        f.fetcher.mock.calls.filter(
          ([path, init]) => String(path) === '/api/sessions/a' && init?.method === 'DELETE',
        ),
      ).toHaveLength(1);
      expect(screen.queryByRole('list', { name: 'Recent sessions' })).toBeNull();
      f.phase('cleaning');
      await vi.waitFor(() =>
        expect(within(row()).getByRole('status').textContent).toContain(
          'Removing temporary files…',
        ),
      );
      await fireEvent.click(
        within(document.querySelector('[data-session-id="b"]') as HTMLElement).getByRole('button', {
          name: /^Open$/,
        }),
      );
      await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
      const prompt = screen.getByRole('textbox', { name: 'Prompt' });
      await fireEvent.input(prompt, { target: { value: 'Other session stays usable' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }));
      expect(submittedSessionId).toBe('b');
      f.finish();
      await fireEvent.click(screen.getByRole('button', { name: /^Sessions$/ }));
      await vi.waitFor(() => expect(document.querySelector('[data-session-id="a"]')).toBeNull());
      expect(
        within(screen.getByRole('list', { name: 'Recent sessions' })).getByText('/forget-me'),
      ).toBeTruthy();
    } finally {
      f.finish();
      f.view.unmount();
    }
  });

  it('restores failed controls with a shared error toast, and retries the retained frame', async () => {
    const f = forgettingFixture();
    try {
      await vi.waitFor(() => expect(screen.getByRole('button', { name: /^Forget$/ })).toBeTruthy());
      await fireEvent.click(screen.getByRole('button', { name: /^Forget$/ }));
      f.phase('failed');
      f.release(new Response(JSON.stringify({ code: 'SESSION_FORGET_FAILED' }), { status: 503 }));
      await vi.waitFor(() =>
        expect(screen.getByRole('button', { name: 'Retry Forget' })).toBeTruthy(),
      );
      expect(screen.getByRole('alert').textContent).toContain(
        'Temporary files could not be removed',
      );
      const row = document.querySelector('[data-session-id="a"]') as HTMLElement;
      expect(row.getAttribute('aria-busy')).toBe('false');
      expect(
        (within(row).getByRole('button', { name: /^Open$/ }) as HTMLButtonElement).disabled,
      ).toBe(false);
      await vi.waitFor(() =>
        expect(
          f.fetcher.mock.calls.some(
            ([path, init]) => String(path) === '/api/sessions/a' && !init?.method,
          ),
        ).toBe(true),
      );
      await fireEvent.click(screen.getByRole('button', { name: 'Retry Forget' }));
      await vi.waitFor(() =>
        expect(
          f.fetcher.mock.calls.filter(
            ([path, init]) => String(path) === '/api/sessions/a' && init?.method === 'DELETE',
          ),
        ).toHaveLength(2),
      );
      expect(screen.queryByRole('list', { name: 'Recent sessions' })).toBeNull();
    } finally {
      f.finish();
      f.view.unmount();
    }
  });

  it.each(['stopping', 'failed'] as const)(
    'rehydrates %s from backend bootstrap after reload',
    async (phase) => {
      const f = forgettingFixture(phase);
      try {
        await vi.waitFor(() =>
          expect(document.querySelector('[data-session-id="a"]')).not.toBeNull(),
        );
        const row = document.querySelector('[data-session-id="a"]') as HTMLElement;
        expect(row.getAttribute('aria-busy')).toBe(String(phase !== 'failed'));
        expect(within(row).getByRole('status').textContent).toContain(
          phase === 'failed' ? 'Could not forget' : 'Forgetting session…',
        );
        expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(
          0,
        );
        if (phase === 'failed')
          expect(screen.getByRole('alert').textContent).toContain(
            'Temporary files could not be removed',
          );
      } finally {
        f.view.unmount();
      }
    },
  );

  it('copies the selected Chat session and removes the header action on other tabs', async () => {
    const writeText = vi.fn(async () => {});
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      await renderChat([
        { id: 'a', state: 'ready', workspacePath: '/a', resumeCommand: 'codex resume thread-a' },
        { id: 'b', state: 'ready', workspacePath: '/b', resumeCommand: 'codex resume thread-b' },
      ]);
      const menu = within(document.querySelector('#configuration-panel') as HTMLElement);
      await fireEvent.click(
        menu.getByRole('button', { name: 'Copy session to CLI', hidden: true }),
      );
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('codex resume thread-a'));
      await fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
      expect(menu.queryByRole('button', { name: 'Copy session to CLI', hidden: true })).toBeNull();
      await fireEvent.click(
        within(screen.getByRole('list', { name: 'Open sessions' })).getAllByRole('button', {
          name: 'Open',
        })[1]!,
      );
      await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
      await fireEvent.click(
        menu.getByRole('button', { name: 'Copy session to CLI', hidden: true }),
      );
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('codex resume thread-b'));
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
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
    window.localStorage.removeItem(NOTIFICATION_HISTORY_STORAGE_KEY);
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
                  models: { codex: [], kimi: [] },
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
  it('presents pending-draft recovery once as a dismissible notification with recent history', async () => {
    cachedDrafts.set('a', {
      text: 'recovered instruction',
      revision: 7,
      pending: [
        { operationId: 'recovered-op', text: 'recovered instruction', revision: 7, kind: 'send' },
      ],
    });

    await renderChat();
    const message =
      'A submitted prompt is being recovered. It will not be sent again automatically. Retry is available.';
    const notifications = screen.getByLabelText('Notifications');
    expect(within(notifications).getAllByText(message)).toHaveLength(1);
    expect(
      screen.queryByText('A previous submission was not confirmed. Retry is available.'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry send' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning notification' }));
    expect(screen.queryByText(message)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Open configuration' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Notifications', hidden: true }));
    expect(screen.getByRole('heading', { name: 'Recent notifications' })).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
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
                  models: { codex: [], kimi: [] },
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
                  models: { codex: [], kimi: [] },
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
                  models: { codex: [], kimi: [] },
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
                  models: { codex: [], kimi: [] },
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
    const sessions = [
      {
        id: 'a',
        state: 'ready',
        workspacePath: '/a',
        lastOrgPlan: { filename: 'a.org', title: 'Plan A', attached: true },
      },
      {
        id: 'b',
        state: 'ready',
        workspacePath: '/b',
        lastOrgPlan: { filename: 'b.org', title: 'Plan B', attached: true },
      },
    ];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === '/api/bootstrap'
              ? {
                  workspaces: [],
                  profiles: [],
                  models: { codex: [], kimi: [] },
                  sessions,
                }
              : String(input) === '/api/sessions'
                ? sessions
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
    expect(screen.getByText('l0')).toBeTruthy();
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
                  models: { codex: [], kimi: [] },
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

describe('RelayApp provider selection', () => {
  afterEach(() => {
    cleanup();
    fakeController = null;
    controllerOptions = null;
    window.localStorage.removeItem(NOTIFICATION_HISTORY_STORAGE_KEY);
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
    if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  function stubBrowserGlobals() {
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
  }

  type RecordedRequest = { url: string; method: string; body: unknown };
  const recordedRequests: RecordedRequest[] = [];

  function bootstrapPayload(providers?: unknown) {
    return {
      workspaces: [
        { id: 'ws1', name: 'repo', relativePath: 'repo', isGitRepository: true, children: [] },
      ],
      profiles: [],
      models: { codex: ['gpt-5.6-terra'], kimi: [] },
      sessions: [],
      capabilities: {
        approvals: true,
        userInput: true,
        git: true,
        protocolCompatible: true,
        ...(providers ? { providers } : {}),
      },
    };
  }

  function renderWithBootstrap(providers?: unknown) {
    recordedRequests.length = 0;
    const authorizedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap')
        return new Response(JSON.stringify(bootstrapPayload(providers)));
      recordedRequests.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url === '/api/sessions' && init?.method === 'POST')
        return new Response(
          JSON.stringify({
            id: 'k1',
            state: 'ready',
            workspacePath: '/repo',
            provider: 'kimi',
            model: 'k2-thinking',
          }),
        );
      if (url === '/api/session-models/kimi' && init?.method === 'POST')
        return new Response(JSON.stringify({ models: ['k2-thinking'] }));
      if (url === '/api/skill-profiles') return new Response(JSON.stringify({ profiles: [] }));
      return new Response(JSON.stringify([]));
    });
    render(RelayApp, {
      authorizedFetch,
      passkeyAuthEnabled: false,
      theme: 'minimal-dark',
      onlock: vi.fn(),
    });
  }

  const kimiProviders = {
    codex: { available: true, version: '1.0' },
    kimi: { available: true, version: '2.0.2' },
  };

  it('starts a kimi session with a kimi model when the provider picker selects kimi', async () => {
    stubBrowserGlobals();
    renderWithBootstrap(kimiProviders);

    const picker = (await screen.findByLabelText('Provider')) as HTMLSelectElement;
    expect(picker.value).toBe('codex');
    await fireEvent.change(picker, { target: { value: 'kimi' } });
    await vi.waitFor(() => expect(screen.queryByLabelText('Sandbox')).toBeNull());
    await vi.waitFor(() =>
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('k2-thinking'),
    );
    expect(recordedRequests.some((request) => request.url === '/api/session-models/kimi')).toBe(
      true,
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    await vi.waitFor(() =>
      expect(recordedRequests.some((request) => request.url === '/api/sessions')).toBe(true),
    );
    const start = recordedRequests.find((request) => request.url === '/api/sessions');
    expect(start?.body).toMatchObject({
      workspaceId: 'ws1',
      provider: 'kimi',
      model: 'k2-thinking',
    });
  });

  it('shows why kimi cannot be selected when it is unavailable', async () => {
    stubBrowserGlobals();
    renderWithBootstrap({
      codex: { available: true, version: '1.0' },
      kimi: { available: false },
    });
    await screen.findByLabelText('Skills profile');
    const picker = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect((picker.querySelector('option[value="kimi"]') as HTMLOptionElement).disabled).toBe(true);
    expect(screen.queryByText(/Kimi is unavailable because its CLI was not found/i)).toBeNull();
    expect(screen.getByLabelText('Sandbox')).toBeTruthy();
  });
});
