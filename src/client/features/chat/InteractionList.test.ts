/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import InteractionList from './InteractionList.svelte';

afterEach(cleanup);

describe('InteractionList', () => {
  it('shows the command above spaced approval controls', async () => {
    const ondecision = vi.fn();
    render(InteractionList, {
      interactions: [
        { requestId: 'request-1', kind: 'commandApproval', payload: { command: 'git status' } },
      ],
      answers: {},
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision,
    });

    expect(screen.getByText('git status').closest('.command-approval-command')).not.toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Approve' })
        .parentElement?.classList.contains('approval-actions'),
    ).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(ondecision).toHaveBeenCalledWith('request-1', 'accept');
  });

  it('shows every file target in the shared spaced approval controls', async () => {
    const ondecision = vi.fn();
    render(InteractionList, {
      interactions: [
        {
          requestId: 'request-2',
          kind: 'fileChangeApproval',
          payload: { changes: [{ path: 'src/a.ts' }, { path: '<escaped>.ts' }] },
        },
      ],
      answers: {},
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision,
    });

    expect(screen.getByRole('list', { name: 'Files to change' }).textContent).toContain('src/a.ts');
    expect(screen.getByRole('list', { name: 'Files to change' }).textContent).toContain(
      '<escaped>.ts',
    );
    const approve = screen.getByRole('button', { name: 'Approve' });
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(approve.parentElement?.classList.contains('approval-actions')).toBe(true);
    expect(deny.parentElement).toBe(approve.parentElement);
    await fireEvent.click(deny);
    expect(ondecision).toHaveBeenCalledWith('request-2', 'decline');
  });

  it('shows an explicit fallback when file details are missing or malformed', () => {
    render(InteractionList, {
      interactions: [
        { requestId: 'request-3', kind: 'fileChangeApproval', payload: { changes: [{ path: 7 }] } },
      ],
      answers: {},
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision: () => {},
    });
    expect(screen.getByText('File details were not provided.')).toBeTruthy();
  });

  it('keeps one keyed card through submitting and resolved states without exposing answers', async () => {
    const ondecision = vi.fn();
    const view = render(InteractionList, {
      interactions: [
        {
          requestId: 'request-state',
          key: 'interaction:request-state',
          kind: 'commandApproval',
          payload: { command: 'git status' },
          state: 'pending',
        },
      ],
      answers: {},
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision,
    });
    const card = screen.getByText('commandApproval').closest('article');
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(ondecision).toHaveBeenCalledTimes(1);

    await view.rerender({
      interactions: [
        {
          requestId: 'request-state',
          key: 'interaction:request-state',
          kind: 'commandApproval',
          payload: { command: 'git status' },
          state: 'submitting',
        },
      ],
    });
    expect(screen.getByText('Submitting…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('commandApproval').closest('article')).toBe(card);

    await view.rerender({
      interactions: [
        {
          requestId: 'request-state',
          key: 'interaction:request-state',
          kind: 'quiz',
          payload: { secret: 'never-rendered' },
          state: 'resolved',
          attemptedOutcome: 'answered',
        },
      ],
    });
    expect(screen.getByText('Answers sent')).toBeTruthy();
    expect(screen.queryByText('never-rendered')).toBeNull();
    expect(screen.getByText('quiz').closest('article')).toBe(card);
    await tick();
    expect(document.activeElement).toBe(screen.getByText('Answers sent'));

    await view.rerender({
      interactions: [
        {
          requestId: 'request-state',
          key: 'interaction:request-state',
          kind: 'userInput',
          payload: null,
          state: 'resolved',
          attemptedOutcome: 'dismissed',
        },
      ],
    });
    expect(screen.getByText('No longer awaiting a response')).toBeTruthy();
  });

  it('keeps every submitted quiz answer visible through delivery and resolution', async () => {
    const submittedAnswers = {
      quiz: [
        {
          id: 'mode',
          header: 'Mode',
          question: 'Which execution mode?',
          answer: 'Supervised multi-agent',
        },
        {
          id: 'review',
          header: 'Review',
          question: 'Who should review?',
          answer: 'Supervisor',
        },
      ],
    };
    const view = render(InteractionList, {
      interactions: [
        {
          requestId: 'quiz',
          kind: 'quiz',
          payload: {},
          state: 'submitting',
        },
      ],
      answers: {},
      submittedAnswers,
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision: () => {},
    });

    const transcript = screen.getByRole('region', { name: 'Submitted answers' });
    expect(transcript.textContent).toContain('Mode — Which execution mode?');
    expect(transcript.textContent).toContain('Supervised multi-agent');
    expect(transcript.textContent).toContain('Review — Who should review?');
    expect(transcript.textContent).toContain('Supervisor');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    await view.rerender({
      interactions: [
        {
          requestId: 'quiz',
          kind: 'quiz',
          payload: null,
          state: 'resolved',
          attemptedOutcome: 'answered',
        },
      ],
      submittedAnswers,
    });
    expect(screen.getByRole('region', { name: 'Submitted answers' })).toBe(transcript);
    expect(screen.getByText('Supervised multi-agent')).toBeTruthy();
    expect(screen.getByText('Answers sent')).toBeTruthy();
  });
});
