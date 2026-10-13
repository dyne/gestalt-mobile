/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { observedBirthExited, observeLiveProcess } from './process-identity.js';

it('acknowledges fixed foreground cancellation only after the real command and its inherited streams close', async () => {
  // Worker protocol/lifetime fixture only. These stubs cannot pass the actual
  // factory's pinned native/helper hashes and create no confinement receipts.
  const root = mkdtempSync('/tmp/live-worker-cancel-');
  const native = join(root, 'native-stub'),
    helper = join(root, 'helper-stub');
  writeFileSync(
    native,
    `#!${process.execPath}\nconst {spawn}=require('node:child_process');const a=process.argv.slice(2),i=a.indexOf('--');const c=spawn(a[i+1],a.slice(i+2),{env:process.env,stdio:'inherit'});process.on('SIGTERM',()=>c.kill('SIGTERM'));c.once('close',()=>process.exit(0));`,
    { mode: 0o700 },
  );
  writeFileSync(
    helper,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(require('node:path').join(process.env.LIVE_UNIT_MARKER_ROOT,process.argv[2]+'.pid'),String(process.pid));setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const worker = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      resolve('src/server/platform/live-design/project-process-worker.ts'),
    ],
    { stdio: ['pipe', 'pipe', 'ignore'], env: {} },
  );
  const closed = once(worker, 'close');
  const lines = createInterface({ input: worker.stdout });
  const messages: Record<string, unknown>[] = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  const send = (value: unknown) => worker.stdin.write(JSON.stringify(value) + '\n');
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('WORKER_UNIT_DEADLINE');
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  let target: ReturnType<typeof observeLiveProcess> | undefined;
  try {
    send({
      op: 'launch',
      specification: {
        role: 'helper',
        native,
        executable: helper,
        argv: ['live-server'],
        environment: { LIVE_UNIT_MARKER_ROOT: root },
        appRoot: root,
        permissionProfile: {},
        port: 12345,
      },
    });
    await until(() => existsSync(join(root, 'live-server.pid')));
    target = observeLiveProcess(Number(readFileSync(join(root, 'live-server.pid'), 'utf8')));
    send({ op: 'helper-command', requestId: 7, args: ['live-status'], deadlineMs: 10000 });
    await until(() => existsSync(join(root, 'live-status.pid')));
    const foreground = observeLiveProcess(
      Number(readFileSync(join(root, 'live-status.pid'), 'utf8')),
    );
    expect(messages.some((message) => message.type === 'helper-command-cancelled')).toBe(false);
    send({ op: 'helper-command-cancel', requestId: 7 });
    await until(() =>
      messages.some(
        (message) => message.type === 'helper-command-cancelled' && message.requestId === 7,
      ),
    );
    expect(observedBirthExited(foreground)).toBe(true);
    expect(observedBirthExited(target)).toBe(false);
    expect(messages.some((message) => message.type === 'helper-command-result')).toBe(false);
  } finally {
    worker.kill('SIGTERM');
    await closed;
    lines.close();
    if (target) await until(() => observedBirthExited(target!));
    rmSync(root, { recursive: true, force: true });
  }
});
