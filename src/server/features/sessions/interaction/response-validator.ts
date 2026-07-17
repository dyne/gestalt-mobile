/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelayInteractionKind } from './kind.js';

/** Validates the relay-safe subset of Codex's generated server-request responses. */
export function isValidInteractionResponse(kind: RelayInteractionKind, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (kind === 'userInput') return isValidUserInputResponse(value);
  if (kind === 'permissionsApproval')
    return isRecord(value.permissions) && (value.scope === 'turn' || value.scope === 'session');
  return isValidApprovalDecision(kind, value.decision);
}

function isValidUserInputResponse(value: Record<string, unknown>): boolean {
  if (!isRecord(value.answers)) return false;
  return Object.values(value.answers).every(
    (answer) =>
      isRecord(answer) &&
      Array.isArray(answer.answers) &&
      answer.answers.every((item) => typeof item === 'string'),
  );
}

function isValidApprovalDecision(
  kind: 'commandApproval' | 'fileChangeApproval',
  value: unknown,
): boolean {
  if (['accept', 'acceptForSession', 'decline', 'cancel'].includes(value as string)) return true;
  if (kind !== 'commandApproval' || !isRecord(value)) return false;
  return (
    (isRecord(value.acceptWithExecpolicyAmendment) &&
      isRecord(value.acceptWithExecpolicyAmendment.execpolicy_amendment)) ||
    (isRecord(value.applyNetworkPolicyAmendment) &&
      isRecord(value.applyNetworkPolicyAmendment.network_policy_amendment))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
