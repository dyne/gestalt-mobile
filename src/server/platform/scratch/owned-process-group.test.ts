/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { stopOwnedProcessGroup } from './owned-process-group.js';

describe('owned process group shutdown', () => {
  it('does not send KILL after the original leader exits during TERM grace', async () => {
    const child = {
      pid: 2147483000,
      kill: vi.fn(),
      exitCode: null as number | null,
      signalCode: null,
    };
    const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
      if (value === 'SIGTERM') child.exitCode = 0;
      return true;
    });
    try {
      expect(await stopOwnedProcessGroup(child, 5, 5)).toBe(false);
      expect(signal).not.toHaveBeenCalledWith(-child.pid, 'SIGKILL');
      expect(signal.mock.calls.slice(1).every(([, value]) => value === 0)).toBe(true);
    } finally {
      signal.mockRestore();
    }
  });
  it('waits for a delayed real descendant and its parent to exit and be reaped', async () => {
    const descendant = `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200)); process.send('ready'); setInterval(()=>{},1000);`;
    const parent = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',()=>process.send('ready')); child.once('exit',()=>process.exit(0));`;
    const child = spawn(process.execPath, ['-e', parent], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const closed = once(child, 'close');
    try {
      let ready = false;
      child.once('message', () => {
        ready = true;
      });
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 2000 });
      const started = Date.now();
      expect(await stopOwnedProcessGroup(child)).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      await closed;
      expect(() => process.kill(-child.pid!, 0)).toThrow();
    } finally {
      // Graceful retry lets the parent reap its descendant even on assertion failure.
      if (!(await stopOwnedProcessGroup(child))) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await closed;
    }
  });

  it('does not treat successful KILL delivery as proof of group exit', async () => {
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      expect(
        await stopOwnedProcessGroup(
          { pid: 2147483000, kill: vi.fn(), exitCode: null, signalCode: null },
          5,
          5,
        ),
      ).toBe(false);
      expect(signal).toHaveBeenCalledWith(-2147483000, 'SIGKILL');
      expect(signal).toHaveBeenLastCalledWith(-2147483000, 0);
    } finally {
      signal.mockRestore();
    }
  });

  it('retains uncertainty for inaccessible and unknown groups', async () => {
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    try {
      expect(
        await stopOwnedProcessGroup({
          pid: 2147483000,
          kill: vi.fn(),
          exitCode: null,
          signalCode: null,
        }),
      ).toBe(false);
    } finally {
      signal.mockRestore();
    }
    expect(
      await stopOwnedProcessGroup({
        pid: undefined,
        kill: vi.fn(),
        exitCode: null,
        signalCode: null,
      }),
    ).toBe(false);
  });
  it('never signals a cached group after its leader exited, even when the group ID is present', async () => {
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      expect(
        await stopOwnedProcessGroup(
          { pid: 2147483000, kill: vi.fn(), exitCode: 75, signalCode: null },
          5,
          5,
        ),
      ).toBe(false);
      expect(signal.mock.calls.length).toBeGreaterThan(0);
      expect(signal.mock.calls.every(([, value]) => value === 0)).toBe(true);
    } finally {
      signal.mockRestore();
    }
  });
});
