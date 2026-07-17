/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProblemDetail } from '../../../shared/contracts/problem.js';
export function problem(
  code: string,
  status: number,
  detail: string,
  retryable = false,
): ProblemDetail {
  return {
    type: `urn:gestalt-mobile:error:${code.toLowerCase()}`,
    title: code.replaceAll('_', ' '),
    status,
    detail,
    code,
    retryable,
  };
}
