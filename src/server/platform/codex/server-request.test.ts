/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { GESTALT_QUIZ_TOOL_NAME } from '../../../shared/contracts/quiz.js';
import { GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME } from '../../../shared/contracts/org-plan-attention.js';
import { GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME } from '../../../shared/contracts/autopilot-wait-lease.js';
import { resolvedServerRequestId, toPendingInteraction } from './server-request.js';

describe('Codex server request mapping', () => {
  it('maps a command approval to the relay interaction vocabulary', () => {
    expect(
      toPendingInteraction({
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'git status' },
      }),
    ).toEqual({ requestId: '7', kind: 'commandApproval', payload: { command: 'git status' } });
  });

  it('maps only a valid gestalt quiz dynamic-tool call into a quiz interaction', () => {
    expect(
      toPendingInteraction({
        id: 8,
        method: 'item/tool/call',
        params: {
          tool: GESTALT_QUIZ_TOOL_NAME,
          arguments: {
            questions: [
              {
                id: 'mode',
                header: 'Mode',
                question: 'Which mode?',
                choices: [
                  { label: 'Fast', description: 'Fast path' },
                  { label: 'Careful', description: 'Careful path' },
                ],
                allowCustom: false,
              },
            ],
          },
        },
      }),
    ).toEqual({
      requestId: '8',
      kind: 'quiz',
      payload: expect.objectContaining({ questions: [expect.objectContaining({ id: 'mode' })] }),
    });
    expect(
      toPendingInteraction({
        id: 9,
        method: 'item/tool/call',
        params: { tool: 'other', arguments: {} },
      }),
    ).toBeNull();
    expect(
      toPendingInteraction({
        id: 10,
        method: 'item/tool/call',
        params: { tool: GESTALT_QUIZ_TOOL_NAME, arguments: { questions: [] } },
      }),
    ).toBeNull();
  });

  it('maps only a valid bounded Org Plan attention call', () => {
    expect(
      toPendingInteraction({
        id: 11,
        method: 'item/tool/call',
        params: {
          tool: GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
          arguments: {
            reason: 'permissionRequired',
            summary: 'A protected deploy requires an approver.',
            requestedAction: 'Grant deployment approval.',
            resumeCondition: 'permissionGranted',
          },
        },
      }),
    ).toEqual({
      requestId: '11',
      kind: 'orgPlanAttention',
      payload: expect.objectContaining({ reason: 'permissionRequired' }),
    });
    expect(
      toPendingInteraction({
        id: 12,
        method: 'item/tool/call',
        params: {
          tool: GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
          arguments: { reason: 'hardBlock', summary: 'x', requestedAction: 'y' },
        },
      }),
    ).toBeNull();
    expect(
      toPendingInteraction({
        id: 13,
        method: 'item/tool/call',
        params: {
          tool: GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
          arguments: {
            reason: 'permissionRequired',
            summary: 'A protected deploy requires an approver.',
            requestedAction: 'Grant deployment approval.',
            resumeCondition: 'planRevision',
          },
        },
      }),
    ).toBeNull();
  });

  it('maps only a structured bounded Autopilot wait lease', () => {
    expect(
      toPendingInteraction({
        id: 14,
        method: 'item/tool/call',
        params: {
          tool: GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME,
          arguments: {
            version: 1,
            reportId: 'report-1',
            leaseId: 'lease-1',
            wakeConditions: ['processExited'],
          },
        },
      }),
    ).toMatchObject({ requestId: '14', kind: 'autopilotWaitLease' });
    expect(
      toPendingInteraction({
        id: 15,
        method: 'item/tool/call',
        params: { tool: GESTALT_AUTOPILOT_WAIT_LEASE_TOOL_NAME, arguments: { version: 1 } },
      }),
    ).toBeNull();
  });

  it('decodes only bounded server-request resolution notifications', () => {
    expect(
      resolvedServerRequestId({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 42 },
      }),
    ).toBe('42');
    expect(
      resolvedServerRequestId({ method: 'serverRequest/resolved', params: { requestId: '' } }),
    ).toBeNull();
    expect(
      resolvedServerRequestId({ method: 'turn/completed', params: { requestId: 42 } }),
    ).toBeNull();
  });
});
