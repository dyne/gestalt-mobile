/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { AttentionAcknowledgement } from './acknowledgement.js';

function fixture() {
  const timers: Array<{ callback(): void; cancelled: boolean; delayMs: number }> = [];
  const recovered: string[] = [];
  const deadlines = new AttentionAcknowledgement({
    deadlineMs: 5_000,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    recoverWriter: (sessionId, requestId) => {
      recovered.push(`${sessionId}:${requestId}`);
    },
  });
  return { deadlines, timers, recovered };
}

describe('attention acknowledgement deadlines', () => {
  it('ignores replaced and duplicate deadlines while recovering the current request once', () => {
    const f = fixture();
    f.deadlines.arm('session', 'request');
    f.deadlines.arm('session', 'request');
    expect(f.timers[0]).toMatchObject({ cancelled: true, delayMs: 5_000 });
    f.timers[0]!.callback();
    expect(f.recovered).toEqual([]);
    f.timers[1]!.callback();
    f.timers[1]!.callback();
    expect(f.recovered).toEqual(['session:request']);
    expect(f.deadlines.responseSettled('session', 'request')).toBe(false);
  });

  it.each(['settlement', 'disposal'] as const)(
    'cancels only the owned session on %s',
    (boundary) => {
      const f = fixture();
      f.deadlines.arm('session', 'request');
      f.deadlines.arm('other', 'request');
      if (boundary === 'settlement')
        expect(f.deadlines.responseSettled('session', 'request')).toBe(true);
      else f.deadlines.disposeSession('session');
      expect(f.timers.map((timer) => timer.cancelled)).toEqual([true, false]);
      f.timers[0]!.callback();
      f.timers[1]!.callback();
      expect(f.recovered).toEqual(['other:request']);
      f.deadlines.disposeSession('other');
    },
  );
});
