/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import MessageList from './MessageList.svelte';

describe('MessageList', () => {
  afterEach(cleanup);

  it('places the collapsible activity log beside commentary in the completed answer heading', () => {
    render(MessageList, {
      messages: [
        {
          id: 'commentary',
          role: 'assistant',
          phase: 'commentary',
          text: 'Checking the workspace.',
          complete: true,
        },
        {
          id: 'answer',
          role: 'assistant',
          phase: 'final_answer',
          text: 'Done.',
          complete: true,
        },
      ],
      activities: [
        { id: 'command', label: 'Command · completed', detail: 'git status' },
      ],
    });

    const heading = screen.getByText('answer').parentElement;
    expect(heading?.querySelector('.commentary-toggle')).not.toBeNull();
    expect(heading?.querySelector('#chat-activity')).not.toBeNull();
    expect(screen.getByText('git status').textContent).toBe('git status');
    expect(heading?.querySelector('#chat-activity')?.getAttribute('open')).toBeNull();
  });

  it('keeps an in-progress activity log expanded while commentary is streaming', () => {
    render(MessageList, {
      messages: [
        {
          id: 'commentary',
          role: 'assistant',
          phase: 'commentary',
          text: 'Checking the workspace.',
          complete: false,
        },
      ],
      activities: [
        { id: 'command', label: 'Command · in_progress', detail: 'git status' },
      ],
    });

    expect(screen.getByText('commentary').closest('details')).not.toBeNull();
    expect(screen.getByText('activity').closest('#chat-activity')?.getAttribute('open')).toBe('');
  });
});
