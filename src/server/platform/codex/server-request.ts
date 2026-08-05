/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PendingInteraction } from '../../features/sessions/model/relay-session.js';
import { GESTALT_QUIZ_TOOL_NAME, parseQuiz } from '../../../shared/contracts/quiz.js';

export function toPendingInteraction(input: {
  id: number;
  method: string;
  params: unknown;
}): PendingInteraction | null {
  if (!Number.isSafeInteger(input.id) || !isRecord(input.params)) return null;
  if (input.method === 'item/tool/call') {
    if (!isRecord(input.params) || input.params.tool !== GESTALT_QUIZ_TOOL_NAME) return null;
    const quiz = parseQuiz(input.params.arguments);
    return quiz ? { requestId: String(input.id), kind: 'quiz', payload: quiz } : null;
  }
  const kind = {
    'item/commandExecution/requestApproval': 'commandApproval',
    'item/fileChange/requestApproval': 'fileChangeApproval',
    'item/permissions/requestApproval': 'permissionsApproval',
    'item/tool/requestUserInput': 'userInput',
  }[input.method] as PendingInteraction['kind'] | undefined;
  return kind ? { requestId: String(input.id), kind, payload: input.params } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
