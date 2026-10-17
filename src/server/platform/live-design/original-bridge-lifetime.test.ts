/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureOriginalBridge, assertOriginalBridgeDrained } from './original-bridge-lifetime.js';
import { observeLiveProcess } from './process-identity.js';
import type { OriginalInstalledSource } from './installed-launch-contract.js';

it('waits for the actual original bridge birth to exit after cold reconfiguration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'live-bridge-lifetime-'));
  const path = join(root, 'context-mode-mcp.mjs');
  writeFileSync(path, 'setInterval(()=>{},1000);\n');
  const child = spawn(process.execPath, [path], { stdio: 'ignore', env: {} });
  const closed = once(child, 'close');
  const source = {
    path,
    interpreter: { path: realpathSync(process.execPath) },
  } as OriginalInstalledSource;
  try {
    await once(child, 'spawn');
    const owner = observeLiveProcess(process.pid);
    const births = captureOriginalBridge(owner, source);
    expect(births.some((birth) => birth.pid === child.pid)).toBe(true);
    let drained = false;
    const waiting = assertOriginalBridgeDrained(owner, births, source).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drained).toBe(false);
    child.kill('SIGTERM');
    await closed;
    await waiting;
    expect(drained).toBe(true);
    expect(() => captureOriginalBridge(owner, source)).toThrow(
      'LIVE_ORIGINAL_BRIDGE_LIFETIME_UNVERIFIED',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not infer ownership or drain from an empty catalog or a configured path alone', () => {
  const owner = observeLiveProcess(process.pid);
  expect(() =>
    captureOriginalBridge(owner, { path: '/unobserved/bridge' } as OriginalInstalledSource),
  ).toThrow('LIVE_ORIGINAL_BRIDGE_LIFETIME_UNVERIFIED');
  expect(captureOriginalBridge(owner)).toEqual([]);
});
