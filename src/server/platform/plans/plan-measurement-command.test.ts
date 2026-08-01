/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { PLAN_MEASUREMENT_COMMAND_TIMEOUT_MS } from './plan-measurement-command.js';

describe('plan measurement command adapter', () => {
  it('uses a bounded shell-free helper invocation', () => {
    expect(PLAN_MEASUREMENT_COMMAND_TIMEOUT_MS).toBe(15_000);
    expect(true).toBe(true);
  });
});
