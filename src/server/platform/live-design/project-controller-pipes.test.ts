/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, existsSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectControllerPipes } from './project-controller-pipes.js';
import { projectNativeStdioCommand } from './project-process-worker.js';

it('gives Native real FIFO stdio and preserves helper argv0 and literal arguments', async () => {
  const root = mkdtempSync('/tmp/live-native-stdio-');
  try {
    const marker = join(root, 'not-created');
    const literal = `$(touch ${marker})`;
    const code = `const fs=require('node:fs'); console.log(JSON.stringify({fifo:[0,1,2].map(fd=>fs.fstatSync(fd).isFIFO()),argv0:process.argv0,args:process.argv.slice(1)}));`;
    const bridge = projectNativeStdioCommand(process.execPath, ['-e', code, '--', literal]);
    const child = spawn(bridge.executable, bridge.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {},
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const [status] = await once(child, 'close');
    expect(status).toBe(0);
    expect(JSON.parse(output)).toEqual({
      fifo: [true, true, true],
      argv0: 'codex-linux-sandbox',
      args: [literal],
    });
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function pair(path: string) {
  const bootstrap = openSync(path, constants.O_RDWR);
  const read = openSync(path, constants.O_RDONLY);
  const write = openSync(path, constants.O_WRONLY);
  closeSync(bootstrap);
  return { read, write };
}
function fixture() {
  const root = mkdtempSync('/tmp/live-fifo-owner-');
  execFileSync('/usr/bin/mkfifo', [join(root, 'in'), join(root, 'out')]);
  const input = pair(join(root, 'in'));
  const output = pair(join(root, 'out'));
  const child = spawn(
    process.execPath,
    ['-e', "process.stdin.pipe(process.stdout); process.stdin.once('end',()=>process.exit(0));"],
    { stdio: [input.read, output.write, 'ignore'], env: {} },
  );
  closeSync(input.read);
  closeSync(output.write);
  const exited = once(child, 'close');
  const errors: string[] = [];
  const pipes = new ProjectControllerPipes(input.write, output.read, (code) => errors.push(code));
  return { root, child, exited, pipes, errors };
}
describe('real FIFO stream descriptor ownership', () => {
  it('streams controller frames and closes once across concurrent repeated Stop', async () => {
    const { root, child, exited, pipes, errors } = fixture();
    try {
      const response = once(pipes.lines, 'line');
      pipes.input.write('owned-frame\n');
      expect((await response)[0]).toBe('owned-frame');
      const first = pipes.close();
      expect(pipes.close()).toBe(first);
      await Promise.all([first, pipes.close(), exited]);
      await pipes.close();
      expect(pipes.input.closed).toBe(true);
      expect(pipes.output.closed).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      child.kill();
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('cleans streams after owner death before startup response without raw double-close', async () => {
    const { root, child, exited, pipes, errors } = fixture();
    try {
      child.kill('SIGKILL');
      await exited;
      await pipes.close();
      expect(pipes.errorCodes()).toEqual([]);
      expect(errors).toEqual([]);
      expect(pipes.input.closed && pipes.output.closed).toBe(true);
    } finally {
      child.kill();
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('records deliberate in-flight write cancellation and still proves both descriptor closures', async () => {
    const { root, child, exited, pipes, errors } = fixture();
    try {
      // An actual round trip establishes construction before racing the next write callback.
      const ready = once(pipes.lines, 'line');
      pipes.input.write('ready\n');
      await ready;
      pipes.input.write('pending-controller-frame\n');
      const closing = pipes.close();
      await Promise.all([closing, exited]);
      expect(pipes.errorCodes()).toEqual(['ERR_STREAM_DESTROYED']);
      expect(errors).toEqual([]);
      expect(pipes.input.closed && pipes.output.closed).toBe(true);
    } finally {
      child.kill();
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses unexpected write destruction outside explicit Stop', async () => {
    const { root, child, exited, pipes, errors } = fixture();
    try {
      const ready = once(pipes.lines, 'line');
      pipes.input.write('ready\n');
      await ready;
      const inputClosed = new Promise<void>((done) => pipes.input.once('close', done));
      pipes.input.write('pending-controller-frame\n');
      pipes.input.destroy();
      await inputClosed;
      child.kill('SIGTERM');
      await exited;
      await expect(pipes.close()).rejects.toThrow('LIVE_PROJECT_PIPE_CLOSE_FAILED');
      expect(errors).toContain('ERR_STREAM_DESTROYED');
      expect(pipes.input.closed && pipes.output.closed).toBe(true);
    } finally {
      child.kill();
      await exited;
      await pipes.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('reports an actual invalid descriptor through readline and refuses to hide cleanup failure', async () => {
    const root = mkdtempSync('/tmp/live-fifo-invalid-');
    execFileSync('/usr/bin/mkfifo', [join(root, 'in'), join(root, 'out')]);
    const input = pair(join(root, 'in'));
    const output = pair(join(root, 'out'));
    closeSync(input.read);
    closeSync(output.write);
    closeSync(output.read);
    const errors: string[] = [];
    const pipes = new ProjectControllerPipes(input.write, output.read, (code) => errors.push(code));
    try {
      await new Promise((done) => setTimeout(done, 20));
      await expect(pipes.close()).rejects.toThrow('LIVE_PROJECT_PIPE_CLOSE_FAILED');
      expect(errors).toContain('EBADF');
      expect(pipes.errorCodes()).toContain('EBADF');
      expect(pipes.input.closed && pipes.output.closed).toBe(true);
    } finally {
      await pipes.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});
