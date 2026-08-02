/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { isRelayPlanUpdate } from './contracts.js';

const plan = { title: 'Plan', steps: [], totalSteps: 0, doneSteps: 0, allDone: true, currentStepId: '' };

describe('relay plan update contract', () => {
  it.each(['supervision-start', 'resync'])('accepts %s from the current helper', (reason) => {
    expect(isRelayPlanUpdate({ plan, reason })).toBe(true);
  });

  it('rejects unknown signal reasons', () => {
    expect(isRelayPlanUpdate({ plan, reason: 'unknown' })).toBe(false);
  });
});
