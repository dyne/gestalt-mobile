/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { AppServer } from '../codex/session-runtime.js';
import { AuxiliaryLifetimes } from './auxiliary-lifetimes.js';

describe('closed auxiliary writer lifetimes', () => {
  it('does not release discovery ownership before an actual child closes', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {},
    });
    const exited = once(child, 'close').then(() => {});
    const lifetimes = new AuxiliaryLifetimes();
    lifetimes.record({ waitForExit: () => exited } as AppServer);
    let released = false;
    const settled = lifetimes.settle().then((proof) => {
      released = true;
      return proof;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(released).toBe(false);
      child.stdin.end();
      expect(await settled).toEqual({
        roots: 0,
        descendants: 0,
        commands: 0,
        approvals: 0,
        unknown: false,
      });
    } finally {
      child.kill();
      await exited;
    }
  });
  it('retains missing or failed process-tree evidence rather than treating idle as closed', async () => {
    const missing = new AuxiliaryLifetimes();
    missing.record({} as AppServer);
    await expect(missing.settle()).rejects.toThrow('LIVE_AUXILIARY_LIFETIME_UNVERIFIED');
    const failed = new AuxiliaryLifetimes();
    failed.record({ waitForExit: () => Promise.reject(new Error('tree remains')) } as AppServer);
    await Promise.resolve();
    await expect(failed.settle()).rejects.toThrow('LIVE_AUXILIARY_LIFETIME_UNVERIFIED');
  });
  it('refuses a newly discovered auxiliary owner while a previous settle awaits closure', async () => {
    let close!: () => void;
    const first = new Promise<void>((resolve) => {
      close = resolve;
    });
    const lifetimes = new AuxiliaryLifetimes();
    lifetimes.record({ waitForExit: () => first } as AppServer);
    const settled = lifetimes.settle();
    lifetimes.record({ waitForExit: () => new Promise<void>(() => {}) } as AppServer);
    close();
    await expect(settled).rejects.toThrow('LIVE_AUXILIARY_LIFETIME_UNVERIFIED');
  });
});
