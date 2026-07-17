import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installShutdownHandlers, packagedClientDir, runCli, usage } from './cli.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function output() {
  let value = '';
  return { stream: { write: (chunk: string) => ((value += chunk), true) }, value: () => value };
}

describe('runCli', () => {
  it('prints help without composing the app or probing Codex', async () => {
    const stdout = output();
    const compose = vi.fn();
    const probeCodexVersion = vi.fn();

    expect(
      await runCli({ args: ['--help'], stdout: stdout.stream, compose, probeCodexVersion }),
    ).toBe(0);
    expect(stdout.value()).toBe(`${usage}\n`);
    expect(compose).not.toHaveBeenCalled();
    expect(probeCodexVersion).not.toHaveBeenCalled();
  });

  it('prints the installed package version without starting the app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-cli-version-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'dist/server/server'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"version":"9.8.7"}');
    const stdout = output();
    const moduleUrl = pathToFileURL(join(root, 'dist/server/server/main.js')).href;

    expect(await runCli({ args: ['--version'], moduleUrl, stdout: stdout.stream })).toBe(0);
    expect(stdout.value()).toBe('9.8.7\n');
  });

  it('reports usage errors on stderr with exit status 2', async () => {
    const stderr = output();
    expect(await runCli({ args: ['--port'], stderr: stderr.stream })).toBe(2);
    expect(stderr.value()).toContain('Missing value for --port');
    expect(stderr.value()).toContain('Usage: gestalt-mobile');
  });

  it.each([['--help'], ['--version']])(
    'rejects %s when combined with other options',
    async (flag) => {
      const stderr = output();
      expect(await runCli({ args: [flag, '--port', '4000'], stderr: stderr.stream })).toBe(2);
    },
  );

  it('starts with package-relative assets and reports the actual listen URL', async () => {
    const root = await createPackageFixture();
    const stdout = output();
    const signals = new EventEmitter();
    const listen = vi.fn(async () => 'http://127.0.0.1:43210');
    const close = vi.fn(async () => {});
    const compose = vi.fn(async () => ({ listen, close }) as never);
    const probeCodexVersion = vi.fn(async () => 'codex-cli 1.2.3');

    expect(
      await runCli({
        args: ['--cwd', '../workspace', '--port', '43210'],
        cwd: '/caller/project',
        moduleUrl: pathToFileURL(join(root, 'dist/server/server/main.js')).href,
        stdout: stdout.stream,
        signalSource: fakeSignals(signals),
        compose,
        probeCodexVersion,
      }),
    ).toBe(0);
    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({
        root: resolve('/caller/workspace'),
        staticDir: resolve(root, 'dist/client'),
        installedCodexVersion: 'codex-cli 1.2.3',
      }),
    );
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 43210 });
    expect(stdout.value()).toBe('Gestalt Mobile listening on http://127.0.0.1:43210\n');
  });

  it('closes the composed app when listening fails', async () => {
    const root = await createPackageFixture();
    const signals = new EventEmitter();
    const close = vi.fn(async () => {});
    const compose = vi.fn(
      async () =>
        ({
          listen: vi.fn(async () => {
            throw new Error('address in use');
          }),
          close,
        }) as never,
    );

    await expect(
      runCli({
        args: [],
        moduleUrl: pathToFileURL(join(root, 'dist/server/server/main.js')).href,
        signalSource: fakeSignals(signals),
        compose,
        probeCodexVersion: async () => null,
      }),
    ).rejects.toThrow('address in use');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('packagedClientDir', () => {
  it('finds client assets relative to the installed module instead of the working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-cli-assets-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'dist/server/server'), { recursive: true });
    await mkdir(join(root, 'dist/client'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"gestalt-mobile"}');
    await writeFile(join(root, 'dist/client/index.html'), '<h1>packed</h1>');
    const moduleUrl = pathToFileURL(join(root, 'dist/server/server/main.js')).href;

    expect(packagedClientDir(moduleUrl)).toBe(resolve(root, 'dist/client'));
  });
});

async function createPackageFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gestalt-cli-package-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'dist/server/server'), { recursive: true });
  await mkdir(join(root, 'dist/client'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"gestalt-mobile","version":"0.1.0"}');
  await writeFile(join(root, 'dist/client/index.html'), '<h1>packed</h1>');
  return root;
}

function fakeSignals(signals: EventEmitter): Pick<NodeJS.Process, 'once' | 'removeListener'> {
  return {
    once: signals.once.bind(signals),
    removeListener: signals.removeListener.bind(signals),
  } as Pick<NodeJS.Process, 'once' | 'removeListener'>;
}

describe('installShutdownHandlers', () => {
  it('closes the app exactly once when multiple termination signals arrive', async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => {});
    const shutdown = installShutdownHandlers({ close }, {
      once: signals.once.bind(signals),
      removeListener: signals.removeListener.bind(signals),
    } as Pick<NodeJS.Process, 'once' | 'removeListener'>);

    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await shutdown();
    await shutdown();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
