/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { decodeCodexFailure } from './codex-failure.js';
import { describeProviderFailure } from '../../../shared/contracts/provider-failure.js';

const isCodexUsageLimit = (notification: { method?: string; params?: unknown }) =>
  decodeCodexFailure(notification)?.code === 'usageLimitExceeded';

describe('Codex provider failures', () => {
  it.each([
    'contextWindowExceeded',
    'sessionBudgetExceeded',
    'usageLimitExceeded',
    'rateLimitExceeded',
    'flexUnavailable',
    'serverOverloaded',
    'cyberPolicy',
    'misalignmentPolicyViolation',
    'tooManyDenials',
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'internalServerError',
    'unauthorized',
    'badRequest',
    'threadRollbackFailed',
    'sandboxError',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
    'activeTurnNotSteerable',
    'other',
  ])('retains and describes %s without persisting error prose', (code) => {
    const decoded = decodeCodexFailure({
      method: 'error',
      params: {
        willRetry: false,
        error: {
          codexErrorInfo: code,
          message: 'secret request',
          additionalDetails: 'secret detail',
        },
      },
    });
    expect(decoded).toEqual({ code });
    expect(describeProviderFailure(decoded!)).not.toContain('no known description');
    expect(JSON.stringify(decoded)).not.toContain('secret');
  });

  it('retains structured HTTP status, handles absent codes, and rejects malformed diagnostics', () => {
    const decode = (codexErrorInfo: unknown) =>
      decodeCodexFailure({
        method: 'turn/completed',
        params: { turn: { status: 'failed', error: { codexErrorInfo } } },
      });
    expect(decode({ httpConnectionFailed: { httpStatusCode: 429, secret: 'ignored' } })).toEqual({
      code: 'httpConnectionFailed',
      httpStatusCode: 429,
    });
    expect(decode(null)).toEqual({ code: 'other' });
    expect(decode('futureError')).toEqual({ code: 'futureError' });
    expect(decode('request with private data')).toEqual({ code: 'other' });
    expect(decode({ httpConnectionFailed: { httpStatusCode: 999 } })).toEqual({
      code: 'httpConnectionFailed',
    });
    expect(
      decodeCodexFailure({
        method: 'item/agentMessage/delta',
        params: { delta: 'usageLimitExceeded' },
      }),
    ).toBeUndefined();
  });
  it('recognizes terminal error and failed completion without retaining provider text', () => {
    const error = { codexErrorInfo: 'usageLimitExceeded', message: 'private provider detail' };
    expect(isCodexUsageLimit({ method: 'error', params: { error, willRetry: false } })).toBe(true);
    expect(
      isCodexUsageLimit({
        method: 'turn/completed',
        params: { turn: { status: 'failed', error } },
      }),
    ).toBe(true);
    expect(isCodexUsageLimit({ method: 'error', params: { error, willRetry: true } })).toBe(false);
    expect(
      isCodexUsageLimit({
        method: 'turn/completed',
        params: { turn: { status: 'completed', error } },
      }),
    ).toBe(false);
  });

  it.each(['contextWindowExceeded', 'sessionBudgetExceeded', 'rateLimitExceeded', 'other', null])(
    'does not classify %s or message prose as account exhaustion',
    (codexErrorInfo) => {
      expect(
        isCodexUsageLimit({
          method: 'error',
          params: {
            willRetry: false,
            error: { codexErrorInfo, message: 'You’ve hit your usage limit' },
          },
        }),
      ).toBe(false);
    },
  );
});
