/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { problem } from './problem.js';
describe('problem', () => {
  it('creates stable problem documents', () =>
    expect(problem('SESSION_NOT_FOUND', 404, 'Missing')).toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
      retryable: false,
    }));
});
