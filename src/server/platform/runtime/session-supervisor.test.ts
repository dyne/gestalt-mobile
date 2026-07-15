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

  it('does not retry after a successful recovery', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const supervisor = new SessionSupervisor(
      async () => {
        attempts += 1;
      },
      () => {},
    );

    supervisor.recover('session-1');
    await vi.runAllTimersAsync();

    expect(attempts).toBe(1);
    vi.useRealTimers();
  });

  it('cancels a scheduled recovery after an explicit stop', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const supervisor = new SessionSupervisor(
      async () => {
        attempts += 1;
        throw new Error('offline');
      },
      () => {},
    );

    supervisor.recover('session-1');
    await Promise.resolve();
    supervisor.cancel('session-1');
    await vi.runAllTimersAsync();

    expect(attempts).toBe(1);
    vi.useRealTimers();
  });

  it('isolates one exhausted recovery from another session', async () => {
    vi.useFakeTimers();
    const attention: string[] = [];
    const supervisor = new SessionSupervisor(
      async (id) => {
        if (id === 'broken') throw new Error('offline');
      },
      (id) => attention.push(id),
    );

    supervisor.recover('broken');
    supervisor.recover('healthy');
    await vi.runAllTimersAsync();

    expect(attention).toEqual(['broken']);
    vi.useRealTimers();
  });
});
