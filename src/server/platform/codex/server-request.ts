/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PendingInteraction } from '../../features/sessions/model/relay-session.js';
import { GESTALT_QUIZ_TOOL_NAME, parseQuiz } from '../../../shared/contracts/quiz.js';
import {
  GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME,
  parseOrgPlanAttention,
} from '../../../shared/contracts/org-plan-attention.js';

export function toPendingInteraction(input: {
  id: number;
  method: string;
  params: unknown;
}): PendingInteraction | null {
  if (!Number.isSafeInteger(input.id) || !isRecord(input.params)) return null;
  if (input.method === 'item/tool/call') {
    if (input.params.tool === GESTALT_QUIZ_TOOL_NAME) {
      const quiz = parseQuiz(input.params.arguments);
      return quiz ? { requestId: String(input.id), kind: 'quiz', payload: quiz } : null;
    }
    if (input.params.tool === GESTALT_ORG_PLAN_ATTENTION_TOOL_NAME) {
      const attention = parseOrgPlanAttention(input.params.arguments);
      return attention
        ? { requestId: String(input.id), kind: 'orgPlanAttention', payload: attention }
        : null;
    }
    return null;
  }
  const kind = {
    'item/commandExecution/requestApproval': 'commandApproval',
    'item/fileChange/requestApproval': 'fileChangeApproval',
    'item/permissions/requestApproval': 'permissionsApproval',
    'item/tool/requestUserInput': 'userInput',
  }[input.method] as PendingInteraction['kind'] | undefined;
  return kind ? { requestId: String(input.id), kind, payload: input.params } : null;
}

export function resolvedServerRequestId(input: {
  method?: string;
  params?: unknown;
}): string | null {
  if (input.method !== 'serverRequest/resolved' || !isRecord(input.params)) return null;
  const requestId = input.params.requestId;
  if (!(
    (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 256) ||
    (typeof requestId === 'number' && Number.isSafeInteger(requestId))
  ))
    return null;
  return String(requestId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
