import { describe, expect, it, vi } from 'vitest';

import { SessionSupervisor } from './session-supervisor.js';

describe('SessionSupervisor', () => {
  it('retries a failed session with bounded backoff before requiring attention', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const attention: string[] = [];
    const supervisor = new SessionSupervisor(
      async (id) => {
        attempts.push(Date.now());
        throw new Error(id);
      },
      (id) => attention.push(id),
    );
    supervisor.recover('session-1');
    await vi.runAllTimersAsync();
    expect(attempts).toHaveLength(4);
    expect(attention).toEqual(['session-1']);
    vi.useRealTimers();
  });
});
