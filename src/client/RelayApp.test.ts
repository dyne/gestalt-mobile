/* Copyright (C) 2026 Dyne.org foundation SPDX-License-Identifier: AGPL-3.0-or-later */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

let controllerOptions: { publish(view: unknown): void } | null = null;
let fakeController: {
  selected: string | null;
  select(id: string | null): void;
  emit(id: string, view: unknown): void;
} | null = null;
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
    dispose = vi.fn();
    send = vi.fn();
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

describe('RelayApp chat controller composition', () => {
  afterEach(() => {
    cleanup();
    controllerOptions = null;
    fakeController = null;
    vi.unstubAllGlobals();
  });
  it('renders controller view after session switch and ignores late old-session content', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('scrollTo', vi.fn());
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
    screen.getByRole('button', { name: /Chat/i }).click();
    await vi.waitFor(() => expect(screen.getByText('session A')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: /Sessions/i }));
    await vi.waitFor(() =>
      expect(screen.getByRole('heading', { name: /Open sessions/i })).toBeTruthy(),
    );
    await fireEvent.click(screen.getByText('/work/b').closest('button')!);
    await vi.waitFor(() => expect(fakeController?.selected).toBe('b'));
    expect(screen.queryByText('session A')).toBeNull();
    fakeController?.emit('a', chatView('a', 'late A'));
    expect(screen.queryByText('late A')).toBeNull();
    fakeController?.emit('b', chatView('b', 'session B'));
    screen.getByRole('button', { name: /Chat/i }).click();
    await vi.waitFor(() => expect(screen.getByText('session B')).toBeTruthy());
  });
});
