/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { GESTALT_QUIZ_TOOL_NAME } from '../../../shared/contracts/quiz.js';
import { toPendingInteraction } from './server-request.js';

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
    expect(toPendingInteraction({ id: 9, method: 'item/tool/call', params: { tool: 'other', arguments: {} } })).toBeNull();
    expect(
      toPendingInteraction({
        id: 10,
        method: 'item/tool/call',
        params: { tool: GESTALT_QUIZ_TOOL_NAME, arguments: { questions: [] } },
      }),
    ).toBeNull();
  });
});
