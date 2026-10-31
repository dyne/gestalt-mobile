/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MessageList from './MessageList.svelte';
import { mcpStartupActivity } from '../../../shared/contracts/mcp-startup-failure.js';

describe('MessageList', () => {
  it('keeps working text expanded and prepends paragraphs without replacing older text', async () => {
    const first = {
      id: 'first',
      role: 'assistant' as const,
      phase: 'commentary' as const,
      turnId: 'turn',
      text: 'Oldest paragraph.\n\nSecond paragraph.',
      complete: false,
    };
    const view = render(MessageList, { messages: [first], activities: [], activeTurnId: 'turn' });
    const oldest = screen.getByText('Oldest paragraph.');
    const progress = screen.getByText('working').closest('.progress-turn');
    expect(
      [...progress!.querySelectorAll('.message-content')].map((node) => node.textContent),
    ).toEqual(['Second paragraph.', 'Oldest paragraph.']);
    expect(progress!.querySelector('details')).toBeNull();
    await view.rerender({
      messages: [first, { ...first, id: 'next', text: 'Newest paragraph.' }],
      activities: [],
      activeTurnId: 'turn',
    });
    expect(screen.getByText('working').closest('.progress-turn')).toBe(progress);
    expect(screen.getByText('Oldest paragraph.')).toBe(oldest);
    expect(
      [...progress!.querySelectorAll('.message-content')].map((node) => node.textContent),
    ).toEqual(['Newest paragraph.', 'Second paragraph.', 'Oldest paragraph.']);
  });

  it('puts streaming answer paragraphs above commentary and restores normal answer order on completion', async () => {
    const messages = [
      {
        id: 'commentary',
        role: 'assistant' as const,
        phase: 'commentary' as const,
        turnId: 'turn',
        text: 'Older status.\n\nNewer status.',
        complete: true,
      },
      {
        id: 'answer',
        role: 'assistant' as const,
        phase: 'final_answer' as const,
        turnId: 'turn',
        text: 'First answer paragraph.\n\nLast answer paragraph.',
        complete: false,
      },
    ];
    const view = render(MessageList, {
      messages,
      activities: [
        { id: 'command', label: 'Command · completed', detail: 'npm test', turnId: 'turn' },
      ],
      activeTurnId: 'turn',
    });
    const working = screen.getByText('working').closest('.answer-turn');
    expect(
      [...working!.querySelectorAll('.message-content')].map((node) => node.textContent),
    ).toEqual([
      'Last answer paragraph.',
      'First answer paragraph.',
      'Newer status.',
      'Older status.',
    ]);
    expect(working!.querySelector('.commentary-toggle, .work-details')).toBeNull();
    await view.rerender({
      messages: messages.map((message) => ({ ...message, complete: true })),
      activities: [],
      activeTurnId: null,
    });
    expect(view.container.querySelector('.working-content')).toBeNull();
    expect(view.container.querySelector('.answer-turn .entry-content')?.textContent).toBe(
      'First answer paragraph.\n\nLast answer paragraph.',
    );
  });

  it.each([null, 'turn-1'])(
    'omits startup-only activity blocks with active turn %j',
    async (activeTurnId) => {
      const activities = [
        ...(
          ['context-mode', 'gestalt-context-mode', 'gestalt-serena', 'gestalt-xerj'] as const
        ).map((serverName) =>
          mcpStartupActivity({
            schemaVersion: 1,
            runtimeId: 'runtime',
            attemptId: 'attempt',
            threadId: null,
            serverName,
            observedAt: '2026-10-31T12:00:00.000Z',
            status: 'ready',
            failure: null,
          }),
        ),
        {
          id: 'gestalt-serena-availability',
          label: 'Serena connected',
          detail: 'Connection verified.',
        },
        { id: 'gestalt-xerj-availability', label: 'Xerj unavailable', detail: 'Use rg.' },
        {
          id: 'gestalt-retrieval-thread-repo',
          label: 'Semantic checks · ready',
          detail: 'Symbols ready; references ready.',
        },
      ];
      const view = render(MessageList, { messages: [], activities, activeTurnId });
      const timeline = screen.getByRole('list', { name: 'Chat messages' });
      expect(timeline.children).toHaveLength(0);
      await view.rerender({
        messages: [],
        activeTurnId,
        activities: [
          ...activities,
          {
            id: 'actual-tool-call',
            label: 'Tool · completed',
            detail: 'gestalt-serena get_symbols_overview',
          },
        ],
      });
      expect(timeline.children).toHaveLength(1);
      expect(timeline.textContent).toContain('gestalt-serena get_symbols_overview');
      expect(timeline.textContent).not.toContain('Serena connected');
      await view.rerender({ messages: [], activities, activeTurnId });
      expect(timeline.children).toHaveLength(0);
    },
  );

  it('does not attach service health to prompts or answers as work details', () => {
    const view = render(MessageList, {
      messages: [
        { id: 'prompt', role: 'user', text: 'Hello', turnId: 'turn-1', complete: true },
        {
          id: 'answer',
          role: 'assistant',
          text: 'How can I help?',
          turnId: 'turn-1',
          complete: true,
        },
      ],
      activities: [
        {
          id: 'gestalt-serena-availability',
          label: 'Serena connected',
          detail: 'Connected',
          turnId: 'turn-1',
        },
      ],
    });
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('How can I help?')).toBeTruthy();
    expect(
      view.container.querySelector('.work-details, .live-activity, .orphan-activity-turn'),
    ).toBeNull();
  });

  it('pins a quiz, renders shared Markdown and file links once, then archives at resolution time', async () => {
    const question = '**Choose** [Source](/workspace/app.ts:12)';
    const quiz = {
      requestId: 'q',
      key: 'q',
      kind: 'quiz',
      turnId: 't',
      state: 'pending' as const,
      occurredAt: 1000,
      payload: {
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question,
            choices: [
              { label: 'Yes', description: 'Read [Notes](</workspace/My Notes.md:3>)' },
              { label: 'No', description: 'Keep current behavior' },
            ],
            allowCustom: true,
          },
        ],
      },
    };
    const messages = [
      {
        id: 'echo',
        role: 'assistant' as const,
        turnId: 't',
        text: question,
        occurredAt: 1500,
        complete: true,
      },
      {
        id: 'later',
        role: 'user' as const,
        text: 'Later message',
        occurredAt: 2000,
        complete: true,
      },
      {
        id: 'newer',
        role: 'assistant' as const,
        text: 'After resolution',
        occurredAt: 4000,
        complete: true,
      },
    ];
    const onopenfile = vi.fn();
    const view = render(MessageList, {
      messages,
      activities: [],
      interactions: [quiz],
      onopenfile,
    });
    const pending = screen.getByRole('complementary', { name: 'Pending chat requests' });
    expect(pending.querySelector('strong')?.textContent).toBe('Choice');
    expect(pending.querySelector('.message-content strong')?.textContent).toBe('Choose');
    expect(screen.getAllByRole('link', { name: 'Source' })).toHaveLength(1);
    await fireEvent.click(screen.getByRole('link', { name: 'Source' }));
    await fireEvent.click(screen.getByRole('link', { name: 'Notes' }));
    expect(onopenfile.mock.calls).toEqual([
      ['/workspace/app.ts', 12],
      ['/workspace/My Notes.md', 3],
    ]);
    await view.rerender({
      messages,
      activities: [],
      interactions: [{ ...quiz, state: 'failed' }],
      onopenfile,
    });
    expect(screen.getByRole('complementary', { name: 'Pending chat requests' })).not.toBeNull();
    await view.rerender({
      messages,
      activities: [],
      interactions: [
        { ...quiz, state: 'resolved', resolvedAt: 3000, attemptedOutcome: 'answered' },
      ],
      onopenfile,
    });
    expect(screen.queryByRole('complementary', { name: 'Pending chat requests' })).toBeNull();
    const entries = screen.getByRole('list', { name: 'Chat messages' }).children;
    expect(entries).toHaveLength(3);
    expect(entries[0]?.textContent).toContain('After resolution');
    expect(entries[1]?.textContent).toContain('Answers sent');
    expect(entries[2]?.textContent).toContain('Later message');
    expect(screen.getAllByRole('link', { name: 'Source' })).toHaveLength(1);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it('renders newest answers before their prompts without mutating chronological input', async () => {
    const messages = [
      { id: 'old-prompt', role: 'user' as const, text: 'Old prompt', complete: true },
      { id: 'old-answer', role: 'assistant' as const, text: 'Old answer', complete: true },
      { id: 'new-prompt', role: 'user' as const, text: 'New prompt', complete: true },
      { id: 'new-answer', role: 'assistant' as const, text: 'New answer', complete: false },
    ];
    const view = render(MessageList, { messages, activities: [] });
    const texts = () =>
      [...screen.getByRole('list', { name: 'Chat messages' }).children].map(
        (entry) => entry.textContent,
      );
    ['New answer', 'New prompt', 'Old answer', 'Old prompt'].forEach((text, index) =>
      expect(texts()[index]).toContain(text),
    );
    expect(messages.map((message) => message.id)).toEqual([
      'old-prompt',
      'old-answer',
      'new-prompt',
      'new-answer',
    ]);
    await view.rerender({
      messages: [
        ...messages,
        { id: 'latest', role: 'user', text: 'Latest prompt', complete: true },
      ],
      activities: [],
    });
    expect(texts()[0]).toContain('Latest prompt');
  });

  it('pins attention above later chat and archives it at resolution without repeating its explanation', async () => {
    const attention = {
      requestId: 'blocker',
      turnId: 'turn',
      requestedAt: '2026-10-10T12:00:01Z',
      attention: {
        reason: 'hardBlock' as const,
        summary: 'Supervised execution requires human attention (hardBlock).',
        requestedAction: 'Resolve the blocker.',
        resumeCondition: 'externalStateChanged' as const,
      },
    };
    const messages = [
      {
        id: 'before',
        role: 'assistant' as const,
        turnId: 'turn',
        phase: 'commentary' as const,
        text: 'The L3 checkpoint cannot be validated because its step is missing.',
        occurredAt: Date.parse('2026-10-10T12:00:00Z'),
        complete: true,
      },
      {
        id: 'request',
        role: 'audit' as const,
        text: 'Needs attention',
        attention,
        occurredAt: Date.parse(attention.requestedAt),
        complete: true,
      },
      {
        id: 'after',
        role: 'user' as const,
        text: 'Later guidance',
        occurredAt: Date.parse('2026-10-10T12:00:02Z'),
        complete: true,
      },
    ];
    const onattentionresolve = vi.fn();
    const view = render(MessageList, { messages, activities: [], attention, onattentionresolve });
    const entries = screen.getByRole('list', { name: 'Chat messages' }).children;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.textContent).toContain('Later guidance');
    const pending = screen.getByRole('complementary', { name: 'Pending chat requests' });
    expect(pending.textContent).toContain('The L3 checkpoint cannot be validated');
    expect(
      pending.compareDocumentPosition(screen.getByRole('list', { name: 'Chat messages' })),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onattentionresolve).toHaveBeenCalledWith('resume');
    await view.rerender({
      messages,
      activities: [],
      attention: null,
      interactions: [
        {
          requestId: 'blocker',
          key: 'blocker',
          kind: 'orgPlanAttention',
          payload: null,
          state: 'resolved',
          resolvedAt: Date.parse('2026-10-10T12:00:03Z'),
        },
      ],
    });
    expect(screen.queryByRole('complementary', { name: 'Pending chat requests' })).toBeNull();
    expect(entries[0]?.textContent).toContain('Autopilot attention request');
    expect(entries[0]?.textContent).toContain('The L3 checkpoint cannot be validated');
    expect(entries[1]?.textContent).toContain('Later guidance');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('places a new attention dialogue above the existing chat even before its audit arrives', () => {
    render(MessageList, {
      messages: [{ id: 'prior', role: 'user', text: 'Existing chat', complete: true }],
      activities: [],
      attention: {
        requestId: 'new',
        turnId: null,
        requestedAt: null,
        attention: {
          reason: 'missingDependency',
          summary: 'The test runner is unavailable.',
          requestedAction: 'Install it.',
          resumeCondition: 'dependencyInstalled',
        },
      },
    });
    const entries = screen.getByRole('list', { name: 'Chat messages' }).children;
    expect(entries[0]?.textContent).toContain('Existing chat');
    expect(
      screen.getByRole('complementary', { name: 'Pending chat requests' }).textContent,
    ).toContain('The test runner is unavailable.');
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

  it('opens local files in the viewer and keeps web links external', async () => {
    const onopenfile = vi.fn();
    render(MessageList, {
      messages: [
        {
          id: 'links',
          role: 'assistant',
          complete: true,
          text: '[Trace](/tmp/trace.json) [Report](</home/me/My Report.md:12>) [Docs](./docs/README.md) [Web](https://example.com)',
        },
      ],
      activities: [],
      onopenfile,
    });
    for (const [name, path] of [
      ['Trace', '/tmp/trace.json'],
      ['Report', '/home/me/My Report.md'],
      ['Docs', './docs/README.md'],
    ]) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('target')).toBeNull();
      await fireEvent.click(link);
      if (name === 'Report') expect(onopenfile).toHaveBeenLastCalledWith(path, 12);
      else expect(onopenfile).toHaveBeenLastCalledWith(path);
    }
    expect(screen.getByRole('link', { name: 'Web' }).getAttribute('target')).toBe('_blank');
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

    const disclosure = screen.getByText('2 files changed · +13 −3').closest('details');
    expect(disclosure?.open).toBe(false);
    await fireEvent.click(screen.getByText('2 files changed · +13 −3'));
    const files = screen.getByRole('region', { name: 'Files changed' });
    expect(files.textContent).toContain('src/app.ts');
    expect(files.textContent).toContain('src/app.test.ts');
    expect(files.querySelectorAll('li')).toHaveLength(2);
    expect(files.textContent).toContain('+5');
    expect(files.textContent).toContain('-3');
    expect(files.textContent).toContain('1s ago');
    expect(screen.queryByText('activity')).toBeNull();
    const answer = screen.getByText('Done.');
    expect(answer.compareDocumentPosition(disclosure!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('attaches child-agent file changes to each root answer instead of the chat tail', () => {
    const start = Date.parse('2026-08-30T12:00:00.000Z');
    render(MessageList, {
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          turnId: 'root-1',
          text: 'First task',
          occurredAt: start,
          complete: true,
        },
        {
          id: 'answer-1',
          role: 'assistant',
          turnId: 'root-1',
          phase: 'final_answer',
          text: 'First done.',
          occurredAt: start + 2_000,
          complete: true,
        },
        {
          id: 'prompt-2',
          role: 'user',
          turnId: 'root-2',
          text: 'Second task',
          occurredAt: start + 3_000,
          complete: true,
        },
        {
          id: 'answer-2',
          role: 'assistant',
          turnId: 'root-2',
          phase: 'final_answer',
          text: 'Second done.',
          occurredAt: start + 5_000,
          complete: true,
        },
      ],
      activities: [
        {
          id: 'child-change-1',
          label: 'File change · completed',
          detail: 'src/first.ts',
          turnId: 'child-1',
          actorTurnId: 'child-1',
          occurredAt: start + 1_000,
          changes: [{ path: 'src/first.ts', additions: 4, deletions: 1 }],
        },
        {
          id: 'child-change-2',
          label: 'File change · completed',
          detail: 'src/second.ts',
          turnId: 'child-2',
          actorTurnId: 'child-2',
          occurredAt: start + 4_000,
          changes: [{ path: 'src/second.ts', additions: 2, deletions: 3 }],
        },
      ],
    });

    const first = screen.getByText('First done.').closest('.answer-turn');
    const second = screen.getByText('Second done.').closest('.answer-turn');
    expect(first?.textContent).toContain('1 file changed · +4 −1');
    expect(first?.textContent).not.toContain('src/second.ts');
    expect(second?.textContent).toContain('1 file changed · +2 −3');
    expect(second?.textContent).not.toContain('src/first.ts');
    expect(document.querySelector('.progress-item')).toBeNull();
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
    expect(prompt?.querySelector('.work-details')).not.toBeNull();
    expect(prompt?.textContent).toContain('Successful commands');
    expect(prompt?.textContent).toContain('1');
    expect(prompt?.textContent).not.toContain('npm test');
    expect(prompt?.textContent).toContain('1 file changed · +? −?');
    expect(screen.getByRole('region', { name: 'Files changed' }).closest('details')?.open).toBe(
      false,
    );
  });

  it('renders a durable resolved interaction as a separate history entry', () => {
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
    expect(prompt?.textContent).not.toContain('Approved');
    expect(screen.getByText('Approved').closest('li')).not.toBe(prompt);
    expect(screen.getByText('Done.').compareDocumentPosition(prompt!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('places unassigned resolved interactions exactly once in history', () => {
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
    expect(screen.getByText('second').closest('.prompt-turn')?.textContent).not.toContain('Denied');
    expect(screen.getAllByText('Denied')).toHaveLength(1);
    view.unmount();
    render(MessageList, { ...props, messages: [] });
    expect(screen.getAllByText('commandApproval')).toHaveLength(2);
  });

  it('does not carry a timed unmatched interaction forward to later prompts', () => {
    const start = Date.UTC(2026, 8, 30, 7, 56, 0);
    render(MessageList, {
      messages: [
        {
          id: 'original-prompt',
          role: 'user',
          turnId: 'root-turn-1',
          text: 'original request',
          occurredAt: start,
          complete: true,
        },
        {
          id: 'later-prompt',
          role: 'user',
          turnId: 'root-turn-2',
          text: 'continue',
          occurredAt: start + 60_000,
          complete: true,
        },
      ],
      activities: [],
      interactions: [
        {
          requestId: 'checkpoint',
          key: 'interaction:checkpoint',
          kind: 'orgPlanCheckpoint',
          turnId: 'unmatched-supervisor-turn',
          payload: null,
          state: 'resolved',
          attemptedOutcome: 'answered',
          occurredAt: start + 30_000,
        },
      ],
    });

    expect(screen.queryByText('orgPlanCheckpoint')).toBeNull();
  });

  it('renders an interaction only once despite duplicated prompt turns', () => {
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
    expect(screen.getByText('second').closest('.prompt-turn')?.textContent).not.toContain(
      'Approved',
    );
    expect(screen.getAllByText('Approved')).toHaveLength(1);
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
      /checking[\s\S]*second[\s\S]*first answer[\s\S]*first/,
    );
    const times = screen.getAllByText(/:/).filter((element) => element.tagName === 'TIME');
    expect(times).toHaveLength(4);
    expect(times.map((time) => time.getAttribute('datetime'))).toEqual(
      [
        new Date(start).toISOString(),
        new Date(start + 60_000).toISOString(),
        new Date(start + 120_000).toISOString(),
        new Date(start + 180_000).toISOString(),
      ].toReversed(),
    );
    expect(times.filter((time) => time.textContent?.includes('1 minute later'))).toHaveLength(3);
  });
});
