/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MessageList from './MessageList.svelte';

describe('MessageList', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('presents automatic continuation history as an audit entry, not a prompt bubble', () => {
    render(MessageList, {
      messages: [
        {
          id: 'automatic',
          role: 'audit',
          text: 'Issued an automatic continuation.',
          complete: true,
        },
      ],
      activities: [],
    });
    const audit = screen.getByLabelText('Autopilot audit entry');
    expect(audit.textContent).toContain('automatic continuation');
    expect(audit.textContent?.match(/Autopilot/g)).toHaveLength(1);
    expect(screen.queryByText('prompt')).toBeNull();
  });
  it('discloses that the durable autopilot audit is intentionally incomplete', () => {
    render(MessageList, {
      messages: [],
      activities: [],
      autopilotAuditTruncated: true,
    });
    expect(screen.getByRole('status').textContent).toContain('Earlier Autopilot audit entries');
  });

  it('routes absolute local Org links through the Plan callback', async () => {
    const onopenorg = vi.fn();
    render(MessageList, {
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          text: 'Open [the plan](/projects/one/plans/roadmap.org:12).',
          complete: true,
        },
      ],
      activities: [],
      onopenorg,
    });

    const link = screen.getByRole('link', { name: 'the plan' });
    expect(link.getAttribute('target')).toBeNull();
    await fireEvent.click(link);
    expect(onopenorg).toHaveBeenCalledWith('/projects/one/plans/roadmap.org:12');
  });

  it('renders Markdown headings and strong emphasis as semantic elements', () => {
    render(MessageList, {
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          text: '### A **clear title**\nThis is **important**.',
          complete: true,
        },
      ],
      activities: [],
    });

    const heading = screen.getByRole('heading', { level: 3, name: 'A clear title' });
    expect(heading.querySelector('strong')?.textContent).toBe('clear title');
    expect(screen.getByText('important').tagName).toBe('STRONG');
  });

  it('copies a fenced code block with an accessible one-click control', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const oncopyresult = vi.fn();
    render(MessageList, {
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          text: '```ts\nconst value = 1;\n```',
          complete: true,
        },
      ],
      activities: [],
      clipboard: { writeText },
      oncopyresult,
    });

    await fireEvent.click(
      screen.getByRole('button', { name: 'Copy code block: const value = 1;' }),
    );

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('const value = 1;\n'));
    expect(oncopyresult).toHaveBeenCalledWith(true);
    expect(screen.getByText('const value = 1;').closest('pre')).not.toBeNull();
  });

  it('reports a fenced-code clipboard failure to the shared feedback boundary', async () => {
    const oncopyresult = vi.fn();
    render(MessageList, {
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          text: '```\nnpm test\n```',
          complete: true,
        },
      ],
      activities: [],
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
      oncopyresult,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Copy code block: npm test' }));

    await vi.waitFor(() => expect(oncopyresult).toHaveBeenCalledWith(false));
  });

  it('wraps commentary and activity only after the answer completes', () => {
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
      activities: [{ id: 'command', label: 'Command · completed', detail: 'git status' }],
    });

    const answer = screen.getByText('Done.').closest('.answer-turn');
    expect(answer?.querySelector('.commentary-toggle')).not.toBeNull();
    expect(answer?.querySelector('.work-details')).not.toBeNull();
    expect(answer?.textContent).toContain('Successful commands');
    expect(answer?.textContent).toContain('1');
    expect(screen.queryByText('git status')).toBeNull();
    expect(answer?.querySelector('.work-details')?.getAttribute('open')).toBeNull();
  });

  it('shows commentary and activity directly in the main timeline while working', () => {
    render(MessageList, {
      messages: [
        {
          id: 'commentary',
          role: 'assistant',
          turnId: 'turn-1',
          phase: 'commentary',
          text: 'Checking the workspace.',
          complete: false,
        },
      ],
      activities: [
        {
          id: 'command',
          label: 'Command · in_progress',
          detail: 'git status',
          turnId: 'turn-1',
        },
      ],
      activeTurnId: 'turn-1',
    });

    const progress = screen.getByText('working').closest('.progress-turn');
    expect(progress?.textContent).toContain('Checking the workspace.');
    expect(progress?.querySelector('.live-activity')).not.toBeNull();
    expect(progress?.querySelector('details')).toBeNull();
  });

  it('keeps changed files inside the answer-owned work-details disclosure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T12:00:05.000Z'));
    render(MessageList, {
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          turnId: 'turn-1',
          phase: 'final_answer',
          text: 'Done.',
          complete: true,
        },
      ],
      activities: [
        {
          id: 'change',
          label: 'File change · completed',
          detail: 'src/app.ts\nsrc/app.test.ts',
          turnId: 'turn-1',
          occurredAt: Date.parse('2026-08-30T12:00:01.000Z'),
          changes: [
            { path: 'src/app.ts', additions: 3, deletions: 1 },
            { path: 'src/app.test.ts', additions: 8, deletions: 0 },
          ],
        },
        {
          id: 'change-again',
          label: 'File change · completed',
          detail: 'src/app.ts',
          turnId: 'turn-1',
          occurredAt: Date.parse('2026-08-30T12:00:04.000Z'),
          changes: [{ path: 'src/app.ts', additions: 2, deletions: 2 }],
        },
      ],
    });

    const disclosure = screen.getByText(/Work details · 2 activities/).closest('details');
    expect(disclosure?.open).toBe(false);
    await fireEvent.click(screen.getByText(/Work details · 2 activities/));
    const files = screen.getByRole('region', { name: 'Files changed' });
    expect(files.textContent).toContain('src/app.ts');
    expect(files.textContent).toContain('src/app.test.ts');
    expect(files.querySelectorAll('li')).toHaveLength(2);
    expect(files.textContent).toContain('+5');
    expect(files.textContent).toContain('-3');
    expect(files.textContent).toContain('1s ago');
    expect(screen.queryByText('activity')).toBeNull();
  });

  it('keeps a completed activity-only turn in history with its owning prompt', () => {
    render(MessageList, {
      messages: [
        {
          id: 'prompt:turn-1',
          role: 'user',
          turnId: 'turn-1',
          text: 'Change the app',
          complete: true,
        },
      ],
      activities: [
        {
          id: 'command',
          label: 'Command · completed',
          detail: 'npm test',
          turnId: 'turn-1',
        },
        {
          id: 'change',
          label: 'File change · completed',
          detail: 'src/app.ts',
          turnId: 'turn-1',
        },
      ],
      activeTurnId: null,
    });

    const prompt = screen.getByText('Change the app').closest('.prompt-turn');
    expect(prompt?.querySelector('.chat-activity')).not.toBeNull();
    expect(prompt?.textContent).toContain('Successful commands');
    expect(prompt?.textContent).toContain('1');
    expect(prompt?.textContent).not.toContain('npm test');
    expect(prompt?.textContent).toContain('src/app.ts');
    expect(screen.getAllByRole('region', { name: 'Files changed' })).toHaveLength(1);
  });

  it('renders a durable resolved interaction in its owning prompt turn', () => {
    render(MessageList, {
      messages: [
        {
          id: 'prompt:one',
          role: 'user',
          turnId: 'turn-1',
          text: 'Inspect the workspace',
          complete: true,
        },
        {
          id: 'assistant:turn-1',
          role: 'assistant',
          turnId: 'turn-1',
          phase: 'final_answer',
          text: 'Done.',
          complete: true,
        },
      ],
      activities: [],
      interactions: [
        {
          requestId: 'request-1',
          key: 'interaction:request-1',
          kind: 'commandApproval',
          turnId: 'turn-1',
          payload: null,
          state: 'resolved',
          attemptedOutcome: 'approved',
        },
      ],
      answers: {},
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision: () => {},
      onretry: () => {},
    });
    const prompt = screen.getByText('Inspect the workspace').closest('.prompt-turn');
    expect(prompt?.textContent).toContain('Approved');
    expect(screen.getByText('Done.').compareDocumentPosition(prompt!)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });

  it('places unassigned interactions exactly once at the latest prompt or interaction-only record', () => {
    const props = {
      activities: [],
      answers: {},
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision: () => {},
      onretry: () => {},
      interactions: [
        {
          requestId: 'null',
          key: 'null',
          kind: 'commandApproval',
          payload: {},
          state: 'resolved' as const,
          attemptedOutcome: 'approved',
        },
        {
          requestId: 'missing',
          key: 'missing',
          kind: 'commandApproval',
          turnId: 'missing-turn',
          payload: {},
          state: 'resolved' as const,
          attemptedOutcome: 'denied',
        },
      ],
    };
    const view = render(MessageList, {
      ...props,
      messages: [
        { id: 'one', role: 'user', text: 'first', complete: true },
        { id: 'two', role: 'user', text: 'second', complete: true },
      ],
    });
    expect(screen.getAllByText('commandApproval')).toHaveLength(2);
    expect(screen.getByText('second').closest('.prompt-turn')?.textContent).toContain('Denied');
    view.unmount();
    render(MessageList, { ...props, messages: [] });
    expect(screen.getAllByText('commandApproval')).toHaveLength(2);
  });

  it('assigns an interaction to only the last prompt record for a duplicated turn', () => {
    render(MessageList, {
      messages: [
        { id: 'first', role: 'user', turnId: 'turn-1', text: 'first', complete: true },
        { id: 'second', role: 'user', turnId: 'turn-1', text: 'second', complete: true },
      ],
      activities: [],
      interactions: [
        {
          requestId: 'only-once',
          key: 'only-once',
          kind: 'commandApproval',
          turnId: 'turn-1',
          payload: {},
          state: 'resolved',
          attemptedOutcome: 'approved',
        },
      ],
      answers: {},
      onanswer: () => {},
      onquiz: () => {},
      onpermission: () => {},
      ondecision: () => {},
      onretry: () => {},
    });
    expect(screen.getAllByText('commandApproval')).toHaveLength(1);
    expect(screen.getByText('first').closest('.prompt-turn')?.textContent).not.toContain(
      'Approved',
    );
    expect(screen.getByText('second').closest('.prompt-turn')?.textContent).toContain('Approved');
  });
  it('renders interleaved groups with one upper-right absolute time per group and relative labels', () => {
    const start = Date.UTC(2026, 6, 15, 12, 0, 0);
    render(MessageList, {
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          turnId: 'turn-1',
          text: 'first',
          occurredAt: start,
          complete: true,
        },
        {
          id: 'answer-1',
          role: 'assistant',
          turnId: 'turn-1',
          phase: 'final_answer',
          text: 'first answer',
          occurredAt: start + 60_000,
          complete: true,
        },
        {
          id: 'prompt-2',
          role: 'user',
          turnId: 'turn-2',
          text: 'second',
          occurredAt: start + 120_000,
          complete: true,
        },
        {
          id: 'commentary-2',
          role: 'assistant',
          turnId: 'turn-2',
          phase: 'commentary',
          text: 'checking',
          occurredAt: start + 180_000,
          complete: false,
        },
      ],
      activities: [],
      activeTurnId: 'turn-2',
    });
    expect(screen.getByRole('list', { name: 'Chat messages' }).textContent).toMatch(
      /first[\s\S]*first answer[\s\S]*second[\s\S]*checking/,
    );
    const times = screen.getAllByText(/:/).filter((element) => element.tagName === 'TIME');
    expect(times).toHaveLength(4);
    expect(times.map((time) => time.getAttribute('datetime'))).toEqual([
      new Date(start).toISOString(),
      new Date(start + 60_000).toISOString(),
      new Date(start + 120_000).toISOString(),
      new Date(start + 180_000).toISOString(),
    ]);
    expect(times.filter((time) => time.textContent?.includes('1 minute later'))).toHaveLength(3);
  });
});
