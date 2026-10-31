/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  compileSkillOverride,
  type SkillSelection,
} from '../../src/server/features/skills/model/skill-profile.js';
import { JsonRpcClient } from '../../src/server/platform/codex/json-rpc-client.js';
import { threadSkillConfig } from '../../src/server/platform/codex/session-runtime.js';
import { CodexSkillCatalog } from '../../src/server/platform/skills/codex-skill-catalog.js';
import { CachedSkillCatalog } from '../../src/server/platform/skills/cached-skill-catalog.js';
import { FilesystemSkillProfileStore } from '../../src/server/platform/skills/filesystem-skill-profile-store.js';
import { ManagedSkillProvenance } from '../../src/server/platform/skills/managed-skill-provenance.js';

const execute = promisify(execFile);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type NativeSkill = { name: string; path: string; enabled: boolean; scope?: string };

/** Opt-in qualification fixture: actual installer and native provider, never a model turn. */
export async function installedSkillsFixture() {
  const wrapper = process.env.VERIFIED_SKILLS_WRAPPER;
  const revision = process.env.VERIFIED_SKILLS_REF;
  const evidenceDirectory = process.env.VERIFIED_SKILLS_EVIDENCE_DIR;
  if (!wrapper || !revision || !evidenceDirectory)
    throw new Error(
      'VERIFIED_SKILLS_WRAPPER, VERIFIED_SKILLS_REF and VERIFIED_SKILLS_EVIDENCE_DIR are required',
    );
  assert.match(revision, /^[a-f0-9]{40}$/);
  await mkdir(evidenceDirectory, { recursive: true });
  const root = await mkdtemp(join(resolve(evidenceDirectory), 'installation-'));
  const home = join(root, 'isolated home');
  const codexHome = join(root, 'custom codex');
  const workspace = join(root, 'unrelated workspace');
  const source = join(root, 'disposable update source');
  const codex = process.env.VERIFIED_SKILLS_CODEX ?? '/usr/bin/codex';
  const managedPath = join(codexHome, 'gestalt-skills/skills/nuklear-gui/SKILL.md');
  const receiptPath = join(codexHome, 'gestalt-skills/receipt.json');
  for (const path of [home, codexHome, workspace, join(root, 'tmp')])
    await mkdir(path, { recursive: true });
  // Construct an allowlisted environment; no real home, credentials, MCP state or source override.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    GESTALT_HOME: join(root, 'custom gestalt'),
    GESTALT_SKILLS_REF: revision,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    TMPDIR: join(root, 'tmp'),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
  };
  const commands: unknown[] = [];
  const nativeSessions: unknown[] = [];
  const maintenance: unknown[] = [];
  const children = new Set<ChildProcessWithoutNullStreams>();
  const closers = new Set<() => Promise<void>>();
  const command = async (
    file: string,
    args: string[],
    cwd = workspace,
    extra: NodeJS.ProcessEnv = {},
  ) => {
    const startedAt = new Date().toISOString();
    try {
      const result = await execute(file, args, {
        cwd,
        env: { ...environment, ...extra },
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      commands.push({
        file,
        args,
        cwd,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return result.stdout.trim();
    } catch (error) {
      commands.push({
        file,
        args,
        cwd,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: (error as { code?: unknown }).code ?? null,
      });
      throw error;
    }
  };
  const launch = (args: string[] = []) => {
    const child = spawn(codex, [...args, 'app-server', '--stdio'], {
      cwd: workspace,
      env: environment,
      stdio: 'pipe',
    });
    children.add(child);
    child.stderr.resume();
    const rpc = new JsonRpcClient(child.stdout, child.stdin);
    child.once('error', (error) => rpc.fail(error));
    child.stdin.on('error', (error) => rpc.fail(error));
    const exited = new Promise<void>((resolveExit) =>
      child.once('close', () => {
        children.delete(child);
        rpc.fail(new Error('qualification process closed'));
        resolveExit();
      }),
    );
    let closing = false;
    const close = async () => {
      if (!closing && children.has(child)) {
        closing = true;
        child.stdin.end();
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        child.once('close', () => clearTimeout(timer));
      }
      await exited;
      closers.delete(close);
    };
    closers.add(close);
    return {
      rpc,
      initialized: () =>
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'),
      close: () => {
        void close();
      },
      settled: close,
    };
  };
  const deadline = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('native qualification request timed out')),
            20_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const rawCatalog = new CodexSkillCatalog('default', () => launch(), 20_000);
  const provenance = new ManagedSkillProvenance(codexHome);
  const catalog = new CachedSkillCatalog(
    (_provider, _profile, cwd) => rawCatalog.list(cwd),
    undefined,
    provenance,
  );
  const profiles = new FilesystemSkillProfileStore(home);
  let originalReceipt: Buffer;
  const record = async () => {
    const receipt = await readFile(receiptPath, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const profile = await readFile(profiles.globalProfilePath('qualification')).catch(() => null);
    if (profile) {
      const saved = await profiles.readGlobalProfile('qualification');
      const enabled = saved?.skills.find((skill) => skill.path === managedPath)?.enabled === true;
      await writeFile(
        join(evidenceDirectory, enabled ? 'profile-enabled.yml' : 'profile-disabled.yml'),
        profile,
      );
    }
    const result = {
      fixture: root,
      workspace,
      home,
      codexHome,
      managedPath,
      receiptPath,
      revision,
      collectionVersion: '0.1.0',
      canonicalSource: 'https://github.com/dyne/gestalt-skills',
      commands,
      maintenance,
      nativeSessions,
      receipt,
      profileSha256: profile ? digest(profile) : null,
      liveOwnedProcesses: children.size,
      observedAt: new Date().toISOString(),
    };
    await writeFile(
      join(evidenceDirectory, 'installed-flow.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    return result;
  };
  const nativeSession = async (label: string, selection: SkillSelection) => {
    const discovered = await rawCatalog.list(workspace);
    const compiled = compileSkillOverride({ discovered: discovered.skills, explicit: selection });
    // The process override permits independent native catalog/config inspection;
    // the same production-compiled snapshot is also sent to actual thread/start.
    const processArgs = [
      '-c',
      `skills.config=[${compiled.skillsConfig.map(({ path, enabled }) => `{path=${JSON.stringify(path)},enabled=${enabled}}`).join(',')}]`,
    ];
    const server = launch(processArgs);
    try {
      await deadline(
        server.rpc.request('initialize', {
          clientInfo: { name: 'installed-skills-qualification', version: '1.0.0' },
          capabilities: {},
        }),
      );
      server.initialized();
      const generated = threadSkillConfig(compiled.skillsConfig);
      const thread = (await deadline(
        server.rpc.request('thread/start', {
          cwd: workspace,
          ...generated,
          sandbox: 'read-only',
          approvalPolicy: 'never',
        }),
      )) as { thread: { id: string; cwd?: string } };
      assert.ok(thread.thread.id);
      const config = (await deadline(
        server.rpc.request('config/read', { includeLayers: false }),
      )) as { config?: { skills?: { config?: unknown[] } } };
      const listed = (await deadline(
        server.rpc.request('skills/list', { cwds: [workspace], forceReload: true }),
      )) as { data: { skills: NativeSkill[]; errors: unknown[] }[] };
      assert.equal(listed.data[0].errors.length, 0);
      const skills = listed.data[0].skills.map(({ name, path, enabled, scope }) => ({
        name,
        path,
        enabled,
        scope,
      }));
      const result = {
        label,
        generated,
        processArgs,
        observedProcessSkillConfig: config.config?.skills?.config ?? null,
        threadStartAccepted: { id: thread.thread.id, cwd: thread.thread.cwd },
        skills,
        observedAt: new Date().toISOString(),
        modelTurns: 0,
      };
      await deadline(server.rpc.request('thread/archive', { threadId: thread.thread.id }));
      nativeSessions.push({ ...result, archived: true });
      return result;
    } finally {
      await server.settled();
      await record();
    }
  };
  const setup = async () => {
    // Real canonical default-source collection install. Infrastructure bootstrap
    // belongs to accepted CLI lifecycle coverage, not this isolated collection fixture.
    const wrapperRevision = await command(
      '/usr/bin/git',
      ['rev-parse', 'HEAD'],
      resolve(dirname(wrapper), '..'),
    );
    const codexVersion = await command(codex, ['--version']);
    await command('/usr/bin/bash', [wrapper, 'skills', 'install']);
    originalReceipt = await readFile(receiptPath);
    await writeFile(join(evidenceDirectory, 'published-install-receipt.json'), originalReceipt);
    const receipt = JSON.parse(originalReceipt.toString());
    assert.equal(receipt.revision, revision);
    assert.equal(receipt.source, 'https://github.com/dyne/gestalt-skills');
    assert.equal(receipt.verifiedSource, true);
    assert.equal(receipt.managedRoot, join(codexHome, 'gestalt-skills'));
    const local = join(codexHome, 'skills/local-control/SKILL.md');
    await mkdir(dirname(local), { recursive: true });
    await writeFile(
      local,
      '---\nname: local-control\ndescription: Ordinary disposable local skill control.\n---\nFixture only.\n',
    );
    const marketplace = join(root, 'local marketplace');
    const plugin = join(marketplace, 'plugins/gestalt');
    for (const path of [
      join(plugin, '.codex-plugin'),
      join(plugin, 'skills/org-plan'),
      join(marketplace, '.agents/plugins'),
    ])
      await mkdir(path, { recursive: true });
    await writeFile(
      join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({
        name: 'gestalt',
        version: '0.0.1',
        description: 'Disposable infrastructure visibility control',
        skills: './skills/',
      }),
    );
    await writeFile(
      join(plugin, 'skills/org-plan/SKILL.md'),
      '---\nname: org-plan\ndescription: Disposable infrastructure advertisement control.\n---\nFixture only, no runtime instructions.\n',
    );
    await writeFile(
      join(marketplace, '.agents/plugins/marketplace.json'),
      JSON.stringify({
        name: 'qualification-controls',
        plugins: [{ name: 'gestalt', source: { source: 'local', path: './plugins/gestalt' } }],
      }),
    );
    await command(codex, ['plugin', 'marketplace', 'add', marketplace]);
    await command(codex, ['plugin', 'add', 'gestalt@qualification-controls']);
    const initial = await catalog.refresh('codex', 'default', workspace);
    assert.equal(initial.skills.filter((skill) => skill.name === 'nuklear-gui').length, 1);
    assert.ok(initial.skills.find((skill) => skill.path === managedPath)?.provenance);
    assert.ok(initial.skills.find((skill) => skill.name === 'local-control')?.enabled);
    assert.ok(initial.skills.find((skill) => skill.name === 'gestalt:org-plan')?.enabled);
    maintenance.push({
      operation: 'fresh default-source collection install',
      wrapperRevision,
      codexVersion,
      receiptSha256: digest(originalReceipt),
      skills: initial.skills.map(({ name, path, enabled, provenance }) => ({
        name,
        path,
        enabled,
        provenance,
      })),
      observedAt: new Date().toISOString(),
    });
    await record();
  };
  const maintain = async (operation: string) => {
    const beforeProfile = await readFile(profiles.globalProfilePath('qualification')).catch(
      () => null,
    );
    if (operation === 'official-update')
      await command('/usr/bin/bash', [wrapper, 'skills', 'update']);
    else if (operation === 'receipt-missing') await rm(receiptPath);
    else if (operation === 'receipt-tampered')
      await writeFile(
        receiptPath,
        JSON.stringify({ ...JSON.parse(originalReceipt.toString()), revision: 'tampered' }),
      );
    else if (operation === 'receipt-restore') await writeFile(receiptPath, originalReceipt);
    else if (operation === 'content-update') {
      await command('/usr/bin/git', [
        'clone',
        '--quiet',
        'https://github.com/dyne/gestalt-skills',
        source,
      ]);
      await command('/usr/bin/git', ['checkout', '--quiet', revision], source);
      const reference = join(source, 'skills/nuklear-gui/references/integration.md');
      await writeFile(
        reference,
        `${await readFile(reference, 'utf8')}\nDisposable local update qualification.\n`,
      );
      await mkdir(join(source, 'skills/new-optional'));
      await writeFile(
        join(source, 'skills/new-optional/SKILL.md'),
        '---\nname: new-optional\ndescription: Disposable complete-profile exclusion control.\n---\nFixture only.\n',
      );
      await command(
        '/usr/bin/python3',
        ['scripts/package.py', 'generate', '--version', '0.1.1'],
        source,
      );
      await command('/usr/bin/git', ['add', 'skills', 'manifest.json'], source);
      await command(
        '/usr/bin/git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--quiet',
          '-m',
          'test: disposable collection update',
        ],
        source,
      );
      const updatedRevision = await command('/usr/bin/git', ['rev-parse', 'HEAD'], source);
      await command('/usr/bin/bash', [wrapper, 'skills', 'update'], workspace, {
        GESTALT_SKILLS_SOURCE: source,
        GESTALT_SKILLS_REF: updatedRevision,
      });
    } else throw new Error('Unknown fixture operation');
    const afterProfile = await readFile(profiles.globalProfilePath('qualification')).catch(
      () => null,
    );
    assert.deepEqual(afterProfile, beforeProfile, 'maintenance must not rewrite the saved profile');
    maintenance.push({
      operation,
      profileUnchanged: true,
      profileSha256: afterProfile ? digest(afterProfile) : null,
      observedAt: new Date().toISOString(),
    });
    return record();
  };
  const close = async () => {
    await Promise.all([...closers].map((stop) => stop()));
    await record();
  };
  try {
    await setup();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    root,
    workspace,
    codexHome,
    managedPath,
    profiles,
    catalog,
    nativeSession,
    maintain,
    record,
    close,
  };
}
