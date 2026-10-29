/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Only structured diagnostics are durable; provider prose may contain request content. */
export type ProviderFailure = Readonly<{ code: string; httpStatusCode?: number }>;

export const providerRetryDelayMs = 60_000;
export const providerRetryLimit = 2;
export const providerContinuationPrompt = 'Continue.';

/** Capacity errors can clear quickly; account, context and policy limits require intervention. */
export function isTransientProviderFailure(failure: ProviderFailure): boolean {
  return failure.code === 'serverOverloaded' || failure.code === 'rateLimitExceeded';
}

const descriptions: Record<string, string> = {
  contextWindowExceeded:
    'The conversation exceeds the model context window. Compact it or start a new session.',
  sessionBudgetExceeded:
    'The Codex session budget is exhausted. Review its budget before continuing.',
  usageLimitExceeded:
    'Codex usage limit reached. Restore available usage or wait for the limit to reset, then resume Autopilot.',
  rateLimitExceeded: 'The request rate limit was reached. Wait before retrying.',
  flexUnavailable: 'Flex processing is unavailable. Retry later or select another service tier.',
  serverOverloaded: 'The model service is overloaded. Retry later.',
  cyberPolicy: 'Codex blocked the request under its cybersecurity policy.',
  misalignmentPolicyViolation: 'Codex blocked the request under its safety policy.',
  tooManyDenials: 'Execution stopped after too many denied requests. Review the requested actions.',
  httpConnectionFailed:
    'The provider HTTP connection failed. Check connectivity and provider availability.',
  responseStreamConnectionFailed: 'Codex could not connect to the response stream.',
  responseStreamDisconnected: 'The provider response stream disconnected before completion.',
  responseTooManyFailedAttempts: 'The provider response failed after repeated attempts.',
  internalServerError: 'Codex encountered an internal server error. Retry later.',
  unauthorized: 'Provider authorization failed. Check the account sign-in or credentials.',
  badRequest: 'The provider rejected the request. Check the selected model and request settings.',
  threadRollbackFailed: 'Codex could not roll back the thread.',
  sandboxError: 'Codex could not execute an action in its sandbox. Review the execution policy.',
  activeTurnNotSteerable: 'The active turn cannot accept steering. Wait for it to finish.',
  other: 'Codex reported an unclassified execution failure.',
};

export function parseProviderFailure(value: unknown): ProviderFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { code, httpStatusCode } = value as Record<string, unknown>;
  if (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code)) return undefined;
  if (
    httpStatusCode !== undefined &&
    (typeof httpStatusCode !== 'number' ||
      !Number.isInteger(httpStatusCode) ||
      httpStatusCode < 100 ||
      httpStatusCode > 599)
  )
    return undefined;
  return {
    code,
    ...(httpStatusCode !== undefined ? { httpStatusCode: httpStatusCode as number } : {}),
  };
}

export function describeProviderFailure(failure: ProviderFailure): string {
  const description = Object.hasOwn(descriptions, failure.code)
    ? descriptions[failure.code]
    : 'Codex reported an execution failure with no known description.';
  return `${failure.code}${failure.httpStatusCode ? ` (HTTP ${failure.httpStatusCode})` : ''}: ${description}`;
}

/** One bounded root recovery episode; persisted so restarts cannot reset its budget. */
export type ProviderRetry = Readonly<{
  turnId: string;
  attempt: number;
  notBefore: string;
  settled: boolean;
  pending: boolean;
  resumeRoot: boolean;
}>;

export function parseProviderRetry(value: unknown): ProviderRetry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r.turnId !== 'string' ||
    !r.turnId ||
    r.turnId.length > 256 ||
    !Number.isInteger(r.attempt) ||
    Number(r.attempt) < 1 ||
    Number(r.attempt) > 2 ||
    typeof r.notBefore !== 'string' ||
    !Number.isFinite(Date.parse(r.notBefore)) ||
    typeof r.settled !== 'boolean' ||
    typeof r.pending !== 'boolean' ||
    typeof r.resumeRoot !== 'boolean'
  )
    return undefined;
  return {
    turnId: r.turnId,
    attempt: r.attempt as number,
    notBefore: r.notBefore,
    settled: r.settled,
    pending: r.pending,
    resumeRoot: r.resumeRoot,
  };
}
