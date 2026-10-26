/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ToolReadiness from './ToolReadiness.svelte';
import {
  unknownReadiness,
  type ReadinessState,
  type SessionRetrievalReadiness,
} from '../../../shared/contracts/retrieval-readiness.js';
afterEach(cleanup);

function status(state: ReadinessState = 'unknown'): SessionRetrievalReadiness {
  const readiness = unknownReadiness();
  readiness.repository = { id: 'a'.repeat(64), label: '/private/same-name-repository' };
  readiness.symbols = { state, observedAt: '2026-10-26T12:00:00Z', generation: 'generation' };
  readiness.references = { ...readiness.symbols };
  return {
    connections: [{ serverName: 'gestalt-serena', readiness }],
    repositories: [{ threadId: 'child-runtime', readiness }],
  };
}

it('keeps old-server fields and connected-but-unverified states explicit', async () => {
  const { rerender } = render(ToolReadiness, { status: null });
  expect(screen.getByRole('region', { name: 'Repository tools' }).textContent).toContain(
    'Read permissions may be unavailable',
  );
  await rerender({ status: {} as SessionRetrievalReadiness });
  expect(document.querySelector('summary')?.textContent).toBe('Unverified');
  const next = status();
  next.connections[0].readiness!.connection.state = 'ready';
  await rerender({ status: next });
  expect(document.querySelector('summary')?.textContent).toBe('Unverified');
  expect(screen.getByText('same-name-repository')).toBeTruthy();
  expect(document.body.textContent).not.toContain('/private/');
});

it.each(['ready', 'unknown', 'stale', 'unavailable'] as const)(
  'presents %s semantics independently from compiler and index unknowns',
  async (state) => {
    render(ToolReadiness, { status: status(state) });
    const summary = document.querySelector('summary')!;
    const label =
      state === 'ready'
        ? 'Ready on observed source'
        : state === 'stale'
          ? 'Stale'
          : state === 'unavailable'
            ? 'Degraded'
            : 'Unverified';
    expect(summary.getAttribute('aria-label')).toBe(`Repository tool readiness: ${label}`);
    expect(document.body.textContent?.replace(/\s+/g, ' ')).toContain(
      'Compiler selection is unverified',
    );
    expect(screen.getByText('Repository index').nextElementSibling?.textContent).toBe('Unverified');
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-26T12:00:00Z');
  },
);

it('preserves native details navigation and invokes only explicit refresh, including busy state', async () => {
  const onrefresh = vi.fn();
  const { rerender } = render(ToolReadiness, { status: status('ready'), onrefresh });
  expect(onrefresh).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: 'Refresh tool readiness', hidden: true });
  await fireEvent.click(button);
  expect(onrefresh).toHaveBeenCalledOnce();
  await rerender({ status: status('stale'), loading: true, onrefresh });
  expect(screen.getByRole('region', { name: 'Repository tools' }).getAttribute('aria-busy')).toBe(
    'true',
  );
  expect(
    (screen.getByRole('button', { name: 'Checking readiness…', hidden: true }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
