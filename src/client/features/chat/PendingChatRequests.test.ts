/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import PendingChatRequests from './PendingChatRequests.svelte';

afterEach(cleanup);
it('keeps unresolved requests visible and distinguishes a retained quiz from a live blocker', async () => {
  const interaction = {
    requestId: 'q',
    key: 'q',
    kind: 'quiz',
    turnId: 'old',
    payload: {},
    state: 'pending' as const,
  };
  const view = render(PendingChatRequests, {
    interactions: [interaction],
    attention: null,
    activeTurnId: 'new',
  });
  expect(screen.getByRole('status').textContent).toContain(
    'Earlier quiz remains unanswered. Autopilot can continue.',
  );
  await view.rerender({
    interactions: [{ ...interaction, turnId: 'new' }],
    attention: null,
    activeTurnId: 'new',
  });
  expect(screen.getByRole('status').textContent).toContain('Quiz answer needed to continue.');
  await view.rerender({ interactions: [{ ...interaction, state: 'resolved' }], attention: null });
  expect(screen.queryByRole('status')).toBeNull();
});
it('shows the supervisor explanation and takes the user to the actionable blocker', async () => {
  const target = document.createElement('section');
  target.id = 'chat-attention-block';
  target.tabIndex = -1;
  target.scrollIntoView = vi.fn();
  document.body.append(target);
  try {
    render(PendingChatRequests, {
      interactions: [],
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
    expect(screen.getByRole('status').textContent).toContain('The build tool is missing.');
    await fireEvent.click(screen.getByRole('button', { name: 'Review Autopilot blocker' }));
    expect(document.activeElement).toBe(target);
    expect(target.scrollIntoView).toHaveBeenCalled();
  } finally {
    target.remove();
  }
});
