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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as identities from '../live-design/process-identity.js';
import * as fileSystem from 'node:fs';
import { LIVE_CODEX_SHA256 } from '../live-design/native-contract.js';

// Explicit test-only module facade keeps native fs behavior while permitting
// deterministic observation-boundary interleavings under ESM.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

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
        const original = identities.observeLiveKernel(f.child.pid!);
        vi.spyOn(identities, 'observeLiveKernel').mockReturnValueOnce({ ...original, birth: '1' });
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

describe('exact managed cwd transition', () => {
  it.each(['initial', 'replacement', 'wrong-intermediate', 'wrong-final'] as const)(
    'supports only the trusted %s directories on the same child',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'live-cwd-fence-'));
      const intermediate = join(root, 'current-manifest'),
        original = join(root, 'original-manifest'),
        forbidden = join(root, 'forbidden');
      for (const path of [intermediate, original, forbidden]) mkdirSync(path);
      const final = mode === 'initial' ? intermediate : original;
      const executable = realpathSync(process.execPath),
        args = ['-e', "process.stdout.write('final\\n');process.stdin.resume()"];
      const spawnedAt = performance.now();
      // Test-only handshakes make each /proc observation stable. They grant no
      // production readiness and never enter the Native/Manager descriptor.
      const child = spawn(
        '/usr/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          'IFS= read -r trigger; cd -- "$1"; shift; printf "intermediate\\n"; IFS= read -r trigger; exec /usr/bin/env --chdir="$1" "${@:2}"',
          'fixed-wrapper',
          mode === 'wrong-intermediate' ? forbidden : intermediate,
          mode === 'wrong-final' ? forbidden : final,
          executable,
          ...args,
        ],
        { cwd: process.cwd(), stdio: 'pipe' },
      );
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      await once(child, 'spawn');
      try {
        const wait = capturedNativeImageFence(
          child,
          {
            executable,
            sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
            args,
            cwd: process.cwd(),
            cwdTransition: { intermediate, final },
          },
          spawnedAt,
        );
        const intermediateReached = once(child.stdout, 'data');
        child.stdin.write('begin\n');
        await intermediateReached;
        if (mode !== 'wrong-intermediate') {
          const finalReached = once(child.stdout, 'data');
          child.stdin.write('continue\n');
          await finalReached;
        }
        if (mode.startsWith('wrong'))
          await expect(wait(new AbortController().signal)).rejects.toMatchObject({
            message: 'LIVE_NATIVE_HANDOFF_UNVERIFIED',
            handoffPhase: 'cwd',
          });
        else
          await expect(wait(new AbortController().signal)).resolves.toMatchObject({
            budgetMs: 90000,
          });
      } finally {
        child.kill('SIGTERM');
        await closed;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

async function nativeImageFixture() {
  const executable = realpathSync(process.execPath),
    args = ['-e', 'process.stdin.resume()'];
  const child = spawn(executable, args, { cwd: process.cwd(), stdio: 'pipe' });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await once(child, 'spawn');
  return {
    child,
    input: {
      executable,
      args,
      cwd: process.cwd(),
      sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    },
    close: async () => {
      child.kill('SIGTERM');
      await closed;
    },
  };
}
describe('kernel-anchored executable FD observation', () => {
  it.each(['pid', 'birth', 'boot', 'uid', 'namespace', 'parent'] as const)(
    'never masks a %s mismatch with a later valid kernel observation',
    async (field) => {
      const f = await nativeImageFixture();
      try {
        const before = identities.observeLiveKernel(f.child.pid!);
        const changed = {
          ...before,
          ...(field === 'pid'
            ? { pid: before.pid + 1 }
            : field === 'birth'
              ? { birth: '1' }
              : field === 'boot'
                ? { bootId: 'wrong' }
                : field === 'uid'
                  ? { uid: before.uid + 1 }
                  : field === 'parent'
                    ? { parentPid: before.parentPid + 1 }
                    : { namespaces: { ...before.namespaces, mnt: 'wrong' } }),
        };
        const observe = vi
          .spyOn(identities, 'observeLiveKernel')
          .mockReturnValueOnce(before)
          .mockReturnValueOnce(changed)
          .mockReturnValue(before);
        await expect(
          capturedNativeImageFence(
            f.child,
            f.input,
            performance.now(),
          )(new AbortController().signal),
        ).rejects.toMatchObject({
          message: 'LIVE_NATIVE_HANDOFF_UNVERIFIED',
          handoffPhase: 'identity',
        });
        expect(observe).toHaveBeenCalledTimes(2);
      } finally {
        vi.restoreAllMocks();
        await f.close();
      }
    },
  );
  it('passes 64 unsynchronized actual Bash→env→Node handoffs with no readiness waits or RPCs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'live-unsynchronized-exec-'));
    const intermediate = join(root, 'current'),
      final = join(root, 'original');
    mkdirSync(intermediate);
    mkdirSync(final);
    const executable = realpathSync(process.execPath),
      args = ['-e', 'process.stdin.resume()'],
      sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
    let verified = 0,
      closedCount = 0;
    try {
      for (let run = 0; run < 64; run++) {
        const seconds = [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01][run % 6];
        const spawnedAt = performance.now();
        const child = spawn(
          '/usr/bin/bash',
          [
            '--noprofile',
            '--norc',
            '-c',
            `IFS= read -r -t ${seconds} line || :; cd -- "$1"; shift; exec /usr/bin/env --chdir="$1" "\${@:2}"`,
            'fixed-wrapper',
            intermediate,
            final,
            executable,
            ...args,
          ],
          { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' },
        );
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        try {
          await once(child, 'spawn');
          await expect(
            capturedNativeImageFence(
              child,
              {
                executable,
                sha256,
                args,
                cwd: process.cwd(),
                cwdTransition: { intermediate, final },
              },
              spawnedAt,
            )(new AbortController().signal),
          ).resolves.toMatchObject({ budgetMs: 90000 });
          verified++;
        } finally {
          child.kill('SIGTERM');
          await closed;
          closedCount++;
        }
      }
      expect(verified).toBe(64);
      expect(closedCount).toBe(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

it.each(['forward', 'backwards', 'unknown', 'final-replaced'] as const)(
  'classifies the deterministic %s executable-FD sequence without error retries',
  async (scenario) => {
    const f = await nativeImageFixture();
    const actualOpen = fileSystem.openSync;
    const native = f.input.executable;
    const paths =
      scenario === 'forward'
        ? ['/usr/bin/bash', '/usr/bin/env', native, native, native]
        : scenario === 'backwards'
          ? ['/usr/bin/bash', '/usr/bin/env', '/usr/bin/bash', native]
          : scenario === 'unknown'
            ? ['/usr/bin/sleep', native]
            : [native, native, '/usr/bin/bash', native];
    let reads = 0;
    const fds = new Set<number>();
    const opened = vi.spyOn(fileSystem, 'openSync').mockImplementation(((...args: unknown[]) => {
      if (args[0] === `/proc/${f.child.pid}/exe`) {
        const target = paths[reads++];
        if (!target) throw new Error('UNEXPECTED_EXTRA_IMAGE_READ');
        const fd = Reflect.apply(actualOpen, fileSystem, [target, ...args.slice(1)]);
        fds.add(fd);
        return fd;
      }
      return Reflect.apply(actualOpen, fileSystem, args);
    }) as typeof fileSystem.openSync);
    try {
      const wait = capturedNativeImageFence(f.child, f.input, performance.now());
      if (scenario === 'forward') {
        await expect(wait(new AbortController().signal)).resolves.toMatchObject({
          budgetMs: 90000,
        });
        expect(reads).toBe(5);
      } else {
        await expect(wait(new AbortController().signal)).rejects.toThrow(
          'LIVE_NATIVE_HANDOFF_UNVERIFIED',
        );
        expect(reads).toBe(scenario === 'unknown' ? 1 : 3);
      }
      for (const fd of fds) expect(() => fileSystem.fstatSync(fd)).toThrow();
      expect(opened).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);
it.each(['source', 'argv', 'kernel', 'cwd', 'digest', 'inode', 'cancel', 'deadline'] as const)(
  'refuses final-candidate %s mutation even when a later observation would be valid',
  async (mutation) => {
    const f = await nativeImageFixture();
    const actualRead = fileSystem.readFileSync,
      actualStat = fileSystem.lstatSync;
    const actualFstat = fileSystem.fstatSync,
      actualPath = fileSystem.realpathSync;
    const actualKernel = identities.observeLiveKernel,
      actualNow = performance.now.bind(performance);
    const spawnTime = actualNow();
    const signal = new AbortController();
    let hashed = false,
      mutated = false;
    vi.spyOn(fileSystem, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      if (hashed && !mutated && mutation === 'argv' && args[0] === `/proc/${f.child.pid}/cmdline`) {
        mutated = true;
        return [f.input.executable, '-e', 'wrong', ''].join('\0');
      }
      const result = Reflect.apply(actualRead, fileSystem, args);
      if (typeof args[0] === 'number') {
        hashed = true;
        if (mutation === 'cancel') signal.abort(new Error('CODEX_STARTUP_CANCELLED'));
        if (mutation === 'digest') {
          mutated = true;
          return Buffer.from('wrong executable bytes');
        }
      }
      return result;
    }) as typeof fileSystem.readFileSync);
    vi.spyOn(fileSystem, 'lstatSync').mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(actualStat, fileSystem, args);
      if (hashed && !mutated && mutation === 'source' && args[0] === f.input.executable) {
        mutated = true;
        return Object.assign(Object.create(result), { ctimeNs: result.ctimeNs + 1n });
      }
      return result;
    }) as typeof fileSystem.lstatSync);
    vi.spyOn(fileSystem, 'fstatSync').mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(actualFstat, fileSystem, args);
      if (hashed && !mutated && mutation === 'inode') {
        mutated = true;
        return Object.assign(Object.create(result), { ino: result.ino + 1n });
      }
      return result;
    }) as typeof fileSystem.fstatSync);
    vi.spyOn(fileSystem, 'realpathSync').mockImplementation(((...args: unknown[]) => {
      if (hashed && !mutated && mutation === 'cwd' && args[0] === `/proc/${f.child.pid}/cwd`) {
        mutated = true;
        return '/forbidden';
      }
      return Reflect.apply(actualPath, fileSystem, args);
    }) as typeof fileSystem.realpathSync);
    vi.spyOn(identities, 'observeLiveKernel').mockImplementation((pid) => {
      const result = actualKernel(pid);
      if (hashed && !mutated && mutation === 'kernel') {
        mutated = true;
        return { ...result, bootId: 'changed' };
      }
      return result;
    });
    vi.spyOn(performance, 'now').mockImplementation(() =>
      hashed && mutation === 'deadline' ? spawnTime + 90001 : actualNow(),
    );
    try {
      await expect(
        capturedNativeImageFence(f.child, f.input, spawnTime)(signal.signal),
      ).rejects.toThrow(
        mutation === 'cancel'
          ? 'CODEX_STARTUP_CANCELLED'
          : mutation === 'deadline'
            ? 'LIVE_NATIVE_HANDOFF_TIMEOUT'
            : 'LIVE_NATIVE_HANDOFF_UNVERIFIED',
      );
      expect(hashed).toBe(true);
      if (['source', 'argv', 'kernel', 'cwd', 'digest', 'inode'].includes(mutation))
        expect(mutated).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it('does not construct or authorize from the full observer whose image fields may race exec', async () => {
  const f = await nativeImageFixture();
  const full = vi.spyOn(identities, 'observeLiveProcess').mockImplementation(() => {
    throw new Error('mixed old image');
  });
  try {
    await expect(
      capturedNativeImageFence(f.child, f.input, performance.now())(new AbortController().signal),
    ).resolves.toMatchObject({ budgetMs: 90000 });
    expect(full).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
