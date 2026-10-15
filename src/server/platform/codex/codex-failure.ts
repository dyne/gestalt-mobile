/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  parseProviderFailure,
  type ProviderFailure,
} from '../../../shared/contracts/provider-failure.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Recognize terminal provider evidence, never conversation text or rounded quota percentages. */
export function decodeCodexFailure(notification: {
  method?: string;
  params?: unknown;
}): ProviderFailure | undefined {
  const params = record(notification.params);
  const turn = record(params?.turn);
  const error =
    notification.method === 'error' && params?.willRetry === false
      ? record(params.error)
      : notification.method === 'turn/completed' && turn?.status === 'failed'
        ? record(turn.error)
        : undefined;
  if (!error) return undefined;
  const info = error.codexErrorInfo;
  if (typeof info === 'string') return parseProviderFailure({ code: info }) ?? { code: 'other' };
  const variant = record(info);
  if (!variant || Object.keys(variant).length !== 1) return { code: 'other' };
  const code = Object.keys(variant)[0]!;
  const status = record(variant[code])?.httpStatusCode;
  return (
    parseProviderFailure({
      code,
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? { httpStatusCode: status }
        : {}),
    }) ?? { code: 'other' }
  );
}
