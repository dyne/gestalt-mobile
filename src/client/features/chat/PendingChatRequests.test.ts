/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import MessageList from './MessageList.svelte';

afterEach(cleanup);
it('keeps unresolved requests at the top across turns and removes the panel after resolution', async () => {
  const interaction = {
    requestId: 'q',
    key: 'q',
    kind: 'commandApproval',
    turnId: 'old',
    payload: { command: 'git status' },
    state: 'pending' as const,
  };
  const props = { messages: [], activities: [], interactions: [interaction], activeTurnId: 'new' };
  const view = render(MessageList, props);
  expect(
    screen.getByRole('complementary', { name: 'Pending chat requests' }).textContent,
  ).toContain('git status');
  await view.rerender({ ...props, activeTurnId: 'another' });
  expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
  await view.rerender({
    ...props,
    interactions: [{ ...interaction, state: 'resolved', resolvedAt: 2000 }],
  });
  expect(screen.queryByRole('complementary', { name: 'Pending chat requests' })).toBeNull();
  expect(screen.getByRole('list', { name: 'Chat messages' }).textContent).toContain('Approved');
});
it('shows one actionable blocker instead of a duplicate summary and review button', async () => {
  const onattentionresolve = vi.fn();
  render(MessageList, {
    messages: [],
    activities: [],
    onattentionresolve,
    attention: {
      requestId: 'block',
      turnId: 't',
      requestedAt: null,
      supervisorReport: 'The build tool is missing.',
      attention: {
        reason: 'missingDependency',
        summary: 'Dependency unavailable.',
        requestedAction: 'Install the build tool.',
        resumeCondition: 'dependencyInstalled',
      },
    },
  });
  expect(screen.getAllByText('The build tool is missing.')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Review Autopilot blocker' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(onattentionresolve).toHaveBeenCalledWith('resume');
});
