/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Manager reason codes only; never propagate subprocess prose or environment values. */
const reasons = [
  'cancelled',
  'timeout',
  'readiness-timeout',
  'unsafe-path',
  'unsupported-installation',
  'unsupported-version',
  'unsupported-binary',
  'unsafe-endpoint',
  'credentials-unavailable',
  'authentication-failed',
  'backend-unavailable',
  'invalid-backend',
  'invalid-mcp',
  'incompatible-mcp',
  'invalid-deadline',
  'invalid-lifecycle-record',
  'lifecycle-busy',
  'endpoint-in-use',
  'launch-failed',
  'probe-failed',
  'manager-unavailable',
  'invalid-manager-response',
  'unknown',
] as const;
export type XerjStartupReason = (typeof reasons)[number];

export function parseXerjStartupReason(value: unknown): XerjStartupReason {
  return typeof value === 'string' && reasons.includes(value as XerjStartupReason)
    ? (value as XerjStartupReason)
    : 'unknown';
}

export function xerjStartupMessage(reason: XerjStartupReason): string {
  switch (reason) {
    case 'timeout':
    case 'readiness-timeout':
      return 'XERJ backend preparation exceeded its time budget.';
    case 'credentials-unavailable':
    case 'authentication-failed':
      return 'XERJ backend authentication is unavailable or was rejected.';
    case 'endpoint-in-use':
      return 'The selected XERJ endpoint is already occupied.';
    case 'unsafe-path':
    case 'unsafe-endpoint':
    case 'unsupported-installation':
    case 'invalid-lifecycle-record':
    case 'invalid-deadline':
      return 'XERJ manager configuration or managed state failed validation.';
    case 'unsupported-version':
    case 'unsupported-binary':
    case 'incompatible-mcp':
      return 'The installed XERJ runtime is incompatible or unavailable.';
    case 'manager-unavailable':
      return 'The Gestalt manager could not be executed.';
    case 'backend-unavailable':
      return 'The XERJ backend could not be reached.';
    case 'launch-failed':
      return 'The managed XERJ backend could not be started.';
    case 'probe-failed':
      return 'The Gestalt manager could not complete its readiness check.';
    case 'invalid-backend':
    case 'invalid-mcp':
    case 'invalid-manager-response':
      return 'XERJ readiness returned an invalid response.';
    case 'lifecycle-busy':
      return 'Another XERJ lifecycle operation is still in progress.';
    case 'cancelled':
      return 'XERJ backend preparation was cancelled.';
    default:
      return 'XERJ backend preparation failed; no more specific cause is available.';
  }
}
