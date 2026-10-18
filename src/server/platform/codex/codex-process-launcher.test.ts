/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  capturedNativeImageFence,
  codexChildEnvironment,
  launchCodexAppServer,
  readLiveProcessEnvironment,
} from './codex-process-launcher.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as identities from '../live-design/process-identity.js';
import { LIVE_CODEX_SHA256 } from '../live-design/native-contract.js';

const inheritedCapabilities = process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
const inheritedPlanStatus = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
const inheritedPlanStatusDirectory = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;

afterEach(() => {
  if (inheritedCapabilities === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
  else process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES = inheritedCapabilities;
  if (inheritedPlanStatus === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = inheritedPlanStatus;
  if (inheritedPlanStatusDirectory === undefined)
    delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = inheritedPlanStatusDirectory;
});

describe('codexChildEnvironment', () => {
  it('observes the actual exec environment and refuses an exited birth', async () => {
    const child = spawn(
      '/usr/bin/env',
      [
        '-i',
        'HOME=/actual-owning-home',
        'CODEX_HOME=/actual-owning-home',
        'TMPDIR=/actual-scratch',
        process.execPath,
        '-e',
        'process.stdout.write("ready");setInterval(()=>{},1000)',
      ],
      { env: { HOME: '/manager-wrapper-home' }, stdio: 'pipe' },
    );
    const closed = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      expect(readLiveProcessEnvironment(child.pid!)).toEqual({
        home: '/actual-owning-home',
        codexHome: '/actual-owning-home',
        tmpdir: '/actual-scratch',
      });
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
    expect(() => readLiveProcessEnvironment(child.pid!)).toThrow(
      'LIVE_RUNTIME_ENVIRONMENT_UNVERIFIED',
    );
  });

  it('refuses an unpinned trusted executable before creating a process', () => {
    expect(() =>
      launchCodexAppServer(
        { profile: 'default', cwd: '/workspace' },
        {
          executable: '/unapproved/native',
          sha256: 'a'.repeat(64),
          environment: {},
        },
      ),
    ).toThrow('LIVE_RUNTIME_BINARY_UNVERIFIED');
    expect(() =>
      launchCodexAppServer(
        { profile: 'default', cwd: '/workspace' },
        {
          executable: '/absent/native',
          sha256: LIVE_CODEX_SHA256,
          environment: {},
        },
      ),
    ).toThrow('LIVE_RUNTIME_BINARY_UNVERIFIED');
  });
  it('does not pass an ambient plan status path to catalog or model discovery children', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES = 'spoofed';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_CAPABILITIES');
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = '/ambient/session';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_FILE');
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY');
  });

  it('scrubs capability assertions from fixed native launch environments too', () => {
    expect(
      codexChildEnvironment(undefined, {
        PATH: '/trusted',
        GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'untrusted',
      }),
    ).toEqual({ PATH: '/trusted' });
    expect(
      codexChildEnvironment(
        { GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'suspension-v1' },
        { PATH: '/trusted', GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'untrusted' },
      ),
    ).toEqual({ PATH: '/trusted', GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'suspension-v1' });
  });

  it('merges only the explicit session runtime path while retaining other inherited values', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    const environment = codexChildEnvironment({
      GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY: '/private/session',
    });
    expect(environment.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY).toBe('/private/session');
    expect(environment.PATH).toBe(process.env.PATH);
  });
});

async function imageFixture(seconds = 0.05) {
  const executable = realpathSync(process.execPath),
    args = ['-e', 'process.stdin.resume()'];
  const child = spawn(
    '/usr/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `IFS= read -r -t ${seconds} line || :; exec "$@"`,
      'fixed-wrapper',
      executable,
      ...args,
    ],
    { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await once(child, 'spawn');
  const input = {
    executable,
    sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    args,
    cwd: process.cwd(),
  };
  return {
    child,
    input,
    closed,
    close: async () => {
      child.kill('SIGTERM');
      await closed;
    },
  };
}
describe('captured Native image transition', () => {
  it('fences immediate exec using stable birth and final image observations', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const f = await imageFixture(0.001);
      try {
        await expect(
          capturedNativeImageFence(
            f.child,
            f.input,
            performance.now(),
          )(new AbortController().signal),
        ).resolves.toMatchObject({ budgetMs: 90000 });
      } finally {
        await f.close();
      }
    }
  });
  it('observes a real same-birth exec after more than five seconds without an RPC or deadline reset', async () => {
    const f = await imageFixture(5.2);
    try {
      const wait = capturedNativeImageFence(f.child, f.input, performance.now());
      const result = await wait(new AbortController().signal);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(5000);
      expect(result.budgetMs).toBe(90000);
      expect(identities.observeLiveProcess(f.child.pid!).executable).toBe(f.input.executable);
      await expect(wait(new AbortController().signal)).rejects.toThrow(
        'LIVE_NATIVE_HANDOFF_UNVERIFIED',
      );
    } finally {
      await f.close();
    }
  }, 10000);
  it.each([
    'argv',
    'cwd',
    'digest',
    'birth',
    'uid',
    'namespace',
    'source',
    'exit',
    'cancel',
    'deadline',
  ])('refuses %s without dispatch or successor authority', async (change) => {
    const f = await imageFixture(0.1);
    const abort = new AbortController();
    let directory: string | undefined;
    try {
      const expected = { ...f.input, args: [...f.input.args] };
      if (change === 'argv') expected.args = ['-e', 'wrong'];
      if (change === 'cwd') expected.cwd = '/wrong';
      if (change === 'digest') expected.sha256 = '0'.repeat(64);
      if (change === 'uid' || change === 'namespace') {
        const original = identities.observeControllerIsolation();
        vi.spyOn(identities, 'observeControllerIsolation').mockReturnValue(
          change === 'uid'
            ? { ...original, uid: original.uid + 1 }
            : { ...original, namespaces: { ...original.namespaces, mnt: 'wrong' } },
        );
      }
      if (change === 'birth') {
        const original = identities.observeLiveProcess(f.child.pid!);
        vi.spyOn(identities, 'observeLiveProcess').mockReturnValueOnce({ ...original, birth: '1' });
      }
      if (change === 'source') {
        directory = mkdtempSync(join(tmpdir(), 'live-image-source-'));
        expected.executable = join(directory, 'image');
        writeFileSync(expected.executable, 'fixed');
      }
      const wait = capturedNativeImageFence(f.child, expected, performance.now());
      if (change === 'source') chmodSync(expected.executable, 0o400);
      if (change === 'exit') {
        f.child.kill('SIGTERM');
        await f.closed;
      }
      if (change === 'cancel') abort.abort(new Error('CODEX_STARTUP_CANCELLED'));
      const failed = wait(abort.signal, change === 'deadline' ? Date.now() - 1 : undefined);
      await expect(failed).rejects.toThrow(
        change === 'deadline'
          ? 'LIVE_NATIVE_HANDOFF_TIMEOUT'
          : change === 'cancel'
            ? 'CODEX_STARTUP_CANCELLED'
            : 'LIVE_NATIVE_HANDOFF_UNVERIFIED',
      );
    } finally {
      vi.restoreAllMocks();
      await f.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
  it('clamps every poll to an earlier caller deadline instead of resetting it', async () => {
    const f = await imageFixture(0.3);
    try {
      const wait = capturedNativeImageFence(f.child, f.input, performance.now());
      await expect(wait(new AbortController().signal, Date.now() + 50)).rejects.toThrow(
        'LIVE_NATIVE_HANDOFF_TIMEOUT',
      );
    } finally {
      await f.close();
    }
  });
  it('does not restart an expired ninety-second deadline when the fence is first consumed', async () => {
    const f = await imageFixture();
    try {
      const wait = capturedNativeImageFence(f.child, f.input, performance.now() - 90001);
      await expect(wait(new AbortController().signal)).rejects.toThrow(
        'LIVE_NATIVE_HANDOFF_TIMEOUT',
      );
      await expect(wait(new AbortController().signal)).rejects.toThrow(
        'LIVE_NATIVE_HANDOFF_UNVERIFIED',
      );
    } finally {
      await f.close();
    }
  });
  it('refuses a wrong executable rather than adopting it', async () => {
    const child = spawn('/usr/bin/sleep', ['10'], { stdio: 'pipe' });
    const closed = new Promise<void>((r) => child.once('close', () => r()));
    await once(child, 'spawn');
    try {
      const wait = capturedNativeImageFence(
        child,
        {
          executable: realpathSync(process.execPath),
          sha256: 'a'.repeat(64),
          args: [],
          cwd: process.cwd(),
        },
        performance.now(),
      );
      await expect(wait(new AbortController().signal)).rejects.toThrow(
        'LIVE_NATIVE_HANDOFF_UNVERIFIED',
      );
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  });
});
