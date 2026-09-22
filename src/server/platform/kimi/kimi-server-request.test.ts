/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  approvalToServerRequest,
  decodeApprovalItems,
  decodeQuestionItems,
  kimiApprovalDecision,
  kimiQuestionAnswers,
  questionToServerRequest,
} from './kimi-server-request.js';

describe('approvalToServerRequest', () => {
  it('steers command-shaped approvals to commandExecution', () => {
    const request = approvalToServerRequest(7, {
      approval_id: 'ap-1',
      tool_name: 'shell_command',
      action: 'run tests',
      tool_input_display: { command: 'npm test' },
    });
    expect(request).toEqual({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'ap-1',
        toolName: 'shell_command',
        reason: 'run tests',
        command: 'npm test',
      },
    });
  });

  it('steers file-mutating approvals to fileChange', () => {
    const request = approvalToServerRequest(8, {
      approval_id: 'ap-2',
      tool_name: 'str_replace_editor',
      tool_input_display: { path: '/repo/a.ts' },
    });
    expect(request?.method).toBe('item/fileChange/requestApproval');
    expect(request?.params).toMatchObject({ itemId: 'ap-2', changes: '/repo/a.ts' });
  });

  it('rejects items without an approval id', () => {
    expect(approvalToServerRequest(1, { approval_id: '' })).toBeNull();
    expect(approvalToServerRequest(1, {} as never)).toBeNull();
  });
});

describe('questionToServerRequest', () => {
  it('builds a requestUserInput payload with bounded questions and options', () => {
    const request = questionToServerRequest(3, {
      question_id: 'q-1',
      questions: [
        {
          id: 'q1',
          question: 'Which target?',
          header: 'Deploy',
          options: [{ id: 'staging', label: 'Staging' }],
        },
      ],
    });
    expect(request).toEqual({
      id: 3,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'q1',
            question: 'Which target?',
            header: 'Deploy',
            options: [{ id: 'staging', label: 'Staging' }],
          },
        ],
      },
    });
  });

  it('rejects items without a question id', () => {
    expect(questionToServerRequest(1, { question_id: '' })).toBeNull();
  });
});

describe('kimiApprovalDecision', () => {
  it('maps relay outcomes to kimi decisions', () => {
    expect(kimiApprovalDecision('accept')).toBe('approved');
    expect(kimiApprovalDecision('acceptForSession')).toBe('approved');
    expect(kimiApprovalDecision('decline')).toBe('rejected');
    expect(kimiApprovalDecision('cancel')).toBe('cancelled');
    expect(kimiApprovalDecision({ other: true })).toBeNull();
  });
});

describe('kimiQuestionAnswers', () => {
  const item = {
    question_id: 'q-1',
    questions: [
      {
        id: 'q1',
        question: 'Which target?',
        options: [
          { id: 'staging', label: 'Staging' },
          { id: 'prod', label: 'Production' },
        ],
      },
      { id: 'q2', question: 'Notes?' },
    ],
  };

  it('matches an option by id or label, else free text, else skipped', () => {
    expect(kimiQuestionAnswers(item, { answers: { q1: { answers: ['prod'] } } })).toEqual({
      q1: { kind: 'single', option_id: 'prod' },
    });
    expect(kimiQuestionAnswers(item, { answers: { q1: { answers: ['Staging'] } } })).toEqual({
      q1: { kind: 'single', option_id: 'staging' },
    });
    expect(kimiQuestionAnswers(item, { answers: { q2: { answers: ['ship it'] } } })).toEqual({
      q2: { kind: 'other', text: 'ship it' },
    });
    expect(kimiQuestionAnswers(item, { answers: { q2: { answers: [] } } })).toEqual({
      q2: { kind: 'skipped' },
    });
  });

  it('rejects malformed responses', () => {
    expect(kimiQuestionAnswers(item, null)).toBeNull();
    expect(kimiQuestionAnswers(item, { answers: [] })).toBeNull();
    expect(kimiQuestionAnswers(item, { answers: {} })).toBeNull();
  });
});

describe('item list decoders', () => {
  it('keeps only well-identified items', () => {
    expect(
      decodeApprovalItems({ items: [{ approval_id: 'a' }, { approval_id: '' }, null, 3] }),
    ).toEqual([{ approval_id: 'a' }]);
    expect(decodeQuestionItems({ items: [{ question_id: 'q' }, { question_id: 2 }] })).toEqual([
      { question_id: 'q' },
    ]);
    expect(decodeApprovalItems({})).toEqual([]);
    expect(decodeQuestionItems(null)).toEqual([]);
  });
});
