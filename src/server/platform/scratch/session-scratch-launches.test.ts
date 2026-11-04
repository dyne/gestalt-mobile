/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexSessionRuntime } from '../codex/session-runtime.js';
import { launchCodexAppServer, codexChildEnvironment } from '../codex/codex-process-launcher.js';
import { profileAppServerCommand } from '../catalog/profile-command.js';
import { FilesystemSessionScratch, scratchMarkerName } from './filesystem-session-scratch.js';
import { withoutSessionScratch } from './child-environment.js';

vi.mock('../catalog/profile-command.js', () => ({ profileAppServerCommand: vi.fn() }));
const execute = promisify(execFile);
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function workspace() {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  await writeFile(join(base, '.gitignore'), '*\n', { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  const path = await mkdtemp(join(base, 'launch-fixture-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

describe('session scratch launch contracts', () => {
  it('captures actual app-server and descendant environments for two sessions and recovery', async () => {
    const root = await workspace();
    const script = join(root, 'server.cjs');
    await writeFile(
      script,
      `
const fs=require('node:fs'), cp=require('node:child_process');
const env=JSON.parse(process.env.GESTALT_SESSION_TMP_CONTEXT);
fs.appendFileSync(env.directory+'/launches.jsonl',JSON.stringify({context:env,tmp:process.env.TMPDIR,child:JSON.parse(cp.execFileSync(process.execPath,['-e','console.log(JSON.stringify({tmp:process.env.TMPDIR,context:process.env.GESTALT_SESSION_TMP_CONTEXT}))'],{encoding:'utf8'}))})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line); if(m.id===undefined)return;
const result=m.method==='thread/start'?{thread:{id:'thread-'+env.ownerId}}:{};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});`,
    );
    vi.mocked(profileAppServerCommand).mockReturnValue({
      command: process.execPath,
      args: [script],
    });
    vi.stubEnv('GESTALT_SESSION_TMP_CONTEXT', 'hostile-ambient');
    vi.stubEnv('TMPDIR', '/hostile-ambient');
    const scratch = new FilesystemSessionScratch();
    const runtime = new CodexSessionRuntime(
      launchCodexAppServer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      64,
      root,
      undefined,
      undefined,
      undefined,
      scratch,
    );
    cleanup.push(() => runtime.stopAll());
    const make = (id: string) =>
      RelaySession.create({
        id,
        provider: 'codex',
        workspaceId: 'workspace',
        workspacePath: root,
        profile: 'default',
        effectiveSkillSelection: { skills: [] },
        now: 't',
      }).snapshot;
    const [first, second] = await Promise.all([
      runtime.start(make('session-one'), 't'),
      runtime.start(make('session-two'), 't'),
    ]);
    await runtime.release(first.id);
    await runtime.restore(first, 'later');
    for (const session of [first, second]) {
      const context = await scratch.allocate(session);
      const launches = (await readFile(join(context.directory, 'launches.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(launches).toHaveLength(session.id === first.id ? 2 : 1);
      for (const launch of launches) {
        expect(launch.tmp).toBe(context.directory);
        expect(launch.child.tmp).toBe(context.directory);
        expect(JSON.parse(launch.child.context)).toEqual(launch.context);
      }
      expect(
        JSON.parse(await readFile(join(context.directory, scratchMarkerName), 'utf8'))
          .providerThreads,
      ).toEqual([{ provider: 'codex', threadId: session.threadId }]);
    }
  });

  it('routes native mktemp, Node and Python to the selected workspace from nested cwd', async () => {
    const root = await workspace();
    const nested = join(root, 'nested repository');
    await mkdir(nested);
    const context = await new FilesystemSessionScratch().allocate({
      id: 'native-session',
      workspacePath: root,
    });
    const env = { ...withoutSessionScratch(), ...context.environment };
    const temporary = (await execute('mktemp', [], { cwd: nested, env })).stdout.trim();
    expect(temporary.startsWith(context.directory + '/')).toBe(true);
    const node = (
      await execute(process.execPath, ['-e', 'console.log(require("node:os").tmpdir())'], {
        cwd: nested,
        env,
      })
    ).stdout.trim();
    const python = (
      await execute('python3', ['-c', 'import tempfile; print(tempfile.gettempdir())'], {
        cwd: nested,
        env,
      })
    ).stdout.trim();
    expect(node).toBe(context.directory);
    expect(python).toBe(context.directory);
  });

  it('scrubs owning-session context from discovery while preserving persistent data variables', () => {
    const ambient = {
      PATH: '/bin',
      CODEX_HOME: '/persistent/codex',
      XERJ_DATA_DIR: '/persistent/xerj',
      TMPDIR: '/caller',
      TMP: '/caller',
      TEMP: '/caller',
      GESTALT_SESSION_TMP_CONTEXT: 'caller',
    };
    expect(codexChildEnvironment(undefined, ambient)).toEqual({
      PATH: '/bin',
      CODEX_HOME: '/persistent/codex',
      XERJ_DATA_DIR: '/persistent/xerj',
    });
    expect(withoutSessionScratch(ambient)).toEqual(codexChildEnvironment(undefined, ambient));
  });
  it('preserves operator temporary roots when no owning-session context exists', () => {
    const environment = {
      PATH: '/bin',
      TMPDIR: '/operator/executable scratch',
      TMP: '/operator/tmp',
      TEMP: '/operator/temp',
    };
    expect(withoutSessionScratch(environment)).toEqual(environment);
    expect(codexChildEnvironment(undefined, environment)).toEqual(environment);
    expect(withoutSessionScratch({ ...environment, GESTALT_SESSION_TMP_CONTEXT: '' })).toEqual({
      PATH: '/bin',
    });
  });

  it('keeps shared service scratch isolated from sessions and protects its lease until explicit release', async () => {
    const root = await workspace();
    const scratch = new FilesystemSessionScratch();
    const service = await scratch.allocateService(root, 'mobile-runtime');
    const session = await scratch.allocate({ id: 'first-caller', workspacePath: root });
    expect(service.directory).not.toBe(session.directory);
    const marker = JSON.parse(await readFile(join(service.directory, scratchMarkerName), 'utf8'));
    expect(marker.ownerKind).toBe('workspace-service');
    const leasePath = join(service.directory, 'leases', marker.authority.leaseId + '.json');
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({
      state: 'active',
      consumers: ['mobile-runtime'],
    });
    await new FilesystemSessionScratch().allocate({ id: 'second-caller', workspacePath: root });
    expect(JSON.parse(await readFile(leasePath, 'utf8')).state).toBe('active');
    await service.release();
    await service.release();
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({
      state: 'released',
      consumers: [],
    });
  });
});
