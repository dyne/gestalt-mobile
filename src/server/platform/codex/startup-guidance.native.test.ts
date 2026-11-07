/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, onTestFinished, vi } from 'vitest';
import { launchCodexAppServer } from './codex-process-launcher.js';
import { CodexSessionRuntime, type AppServer } from './session-runtime.js';
import { CodexCapabilities } from './codex-capabilities.js';
import { CodexSerena } from './codex-serena.js';
import { CodexXerj } from '../retrieval/codex-xerj.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import {
  compileSkillOverride,
  createSkillProfile,
  type AvailableSkill,
} from '../../features/skills/model/skill-profile.js';
import { sessionScratchEnvironmentKeys } from '../scratch/child-environment.js';
import {
  installStartupFixture,
  syntheticBlock,
  syntheticBootstrap,
} from './startup-guidance.fixture.js';

type ModelInput = {
  instructions?: string;
  input: Array<{ role?: string; content?: string | Array<{ text?: string }> }>;
};
const count = (text: string, needle: string) => text.split(needle).length - 1;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const run = promisify(execFile);
function roleComponents(input: ModelInput) {
  return input.input
    .filter((item) => item.role === 'system' || item.role === 'developer')
    .flatMap((item) =>
      (typeof item.content === 'string'
        ? [item.content]
        : (item.content?.map((part) => part.text) ?? [])
      )
        .filter((text): text is string => typeof text === 'string')
        .map((text) => ({ role: item.role, text })),
    );
}
const components = (input: ModelInput) => roleComponents(input).map((component) => component.text);
const providerConfig = (port: number) =>
  `[model_providers.fixture]\nname='fixture'\nbase_url='http://127.0.0.1:${port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\n`;

// Explicit opt-in matches codex-clean-start: no native CLI dependency for the unit suite.
// Real native protocol + local synthetic provider. Captures stay in memory and contain only fixtures.
it
  .skipIf(process.env.RUN_INSTALLED_CODEX !== '1')
  .each([
    'empty',
    'custom',
    'relay-skill-profile-role',
    'role-owned-block',
    'explicit-foundation',
    'older-package',
    'readback-failure',
  ])(
  'native Mobile startup preserves instruction components and delivers selected package: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'mobile native startup '));
    const home = join(root, 'home'),
      workspace = join(root, 'workspace'),
      marketplace = join(root, 'marketplace');
    await Promise.all(
      [home, workspace, join(marketplace, '.agents/plugins')].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    const packageRoot = join(marketplace, 'plugins/gestalt');
    await installStartupFixture(packageRoot);
    await writeFile(
      join(marketplace, '.agents/plugins/marketplace.json'),
      JSON.stringify({
        name: 'mobile-startup-fixture',
        plugins: [{ name: 'gestalt', source: { source: 'local', path: './plugins/gestalt' } }],
      }),
    );
    const captures: ModelInput[] = [];
    const model = createServer(async (request, response) => {
      let raw = '';
      for await (const data of request) raw += String(data);
      captures.push(JSON.parse(raw) as ModelInput);
      const item = {
        id: `msg_${captures.length}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Synthetic fixture complete.', annotations: [] }],
      };
      const result = {
        id: `resp_${captures.length}`,
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'fixture',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: result },
      ])
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    const processes: Array<AppServer & { closeAndWait(): Promise<void> }> = [];
    const runtimes: CodexSessionRuntime[] = [];
    onTestFinished(async () => {
      for (const runtime of runtimes) await runtime.release('fixture');
      for (const process of processes) await process.closeAndWait();
      model.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        model.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as { port: number }).port;
    const profileCase = mode === 'relay-skill-profile-role';
    const scalar =
      mode === 'empty'
        ? ''
        : mode.includes('role')
          ? (profileCase ? 'CUSTOM_NATIVE_GUIDANCE\n' : '') +
            'ROLE_ONLY_DUTIES' +
            (mode === 'role-owned-block' ? '\n' + syntheticBlock : '')
          : 'CUSTOM_NATIVE_GUIDANCE';
    const optionalSkillPath = join(home, 'skills/fixture-review/SKILL.md');
    const skillProfile = createSkillProfile({
      name: 'fixture-review',
      skills: [{ name: 'fixture-review', path: optionalSkillPath, enabled: true }],
    });
    if (profileCase) {
      await mkdir(join(home, 'skills/fixture-review'), { recursive: true });
      await writeFile(
        optionalSkillPath,
        '---\nname: fixture-review\ndescription: Synthetic Mobile selected skill\n---\nSYNTHETIC_SELECTED_SKILL\n',
      );
    }
    if (mode === 'explicit-foundation')
      await writeFile(join(home, 'foundation.md'), 'EXPLICIT_FOUNDATION\n');
    await writeFile(
      join(home, 'config.toml'),
      `model='fixture'\nmodel_provider='fixture'\napproval_policy='never'\npersonality='pragmatic'\ndeveloper_instructions=${JSON.stringify(scalar)}\n${mode === 'explicit-foundation' ? 'model_instructions_file=' + JSON.stringify(join(home, 'foundation.md')) + '\n' : ''}${providerConfig(port)}[features]\nhooks=true\ntool_search=false\n[skills]\n[[skills.config]]\nname='gestalt:xerj'\nenabled=false\n[[skills.config]]\nname='gestalt:serena'\nenabled=false\n`,
    );
    const environment = { ...process.env, CODEX_HOME: home };
    for (const args of [
      ['plugin', 'marketplace', 'add', marketplace],
      ['plugin', 'add', 'gestalt@mobile-startup-fixture'],
    ])
      await run('codex', args, { env: environment, cwd: workspace, timeout: 15_000 });
    const installed = join(home, 'plugins/cache/mobile-startup-fixture/gestalt/0.0.1');
    if (mode === 'older-package') await rm(join(installed, 'gestalt-startup-contract.json'));
    await writeFile(join(workspace, 'AGENTS.md'), 'REPOSITORY_NATIVE_GUIDANCE');
    const originalConfig = await readFile(join(home, 'config.toml'), 'utf8');
    const sent: Array<{ method: string; params: unknown }> = [];
    const completed = new Set<string>();
    const open = (): AppServer & { closeAndWait(): Promise<void> } => {
      const owningEnvironment: Record<string, string> = { CODEX_HOME: home };
      for (const key of sessionScratchEnvironmentKeys)
        if (process.env[key] !== undefined) owningEnvironment[key] = process.env[key]!;
      const nativeProcess = launchCodexAppServer({
        profile: 'default',
        cwd: workspace,
        environment: owningEnvironment,
      });
      const native = nativeProcess.rpc;
      native.onNotification((notification) => {
        if (notification.method === 'turn/completed')
          completed.add((notification.params as { turn: { id: string } }).turn.id);
      });
      const server = {
        ...nativeProcess,
        rpc: {
          request: async (method: string, params: unknown) => {
            sent.push({ method, params });
            const result = await native.request(method, params);
            if (method === 'initialize') {
              const resolved = (await native.request('config/read', {
                cwd: workspace,
                includeLayers: false,
              })) as { config: { developer_instructions?: string } };
              expect(digest(resolved.config.developer_instructions ?? '')).toBe(digest(scalar));
              const discovered = (await native.request('skills/list', {
                cwds: [workspace],
                forceReload: true,
              })) as { data: Array<{ cwd: string; skills: AvailableSkill[] }> };
              const fixtureSkills = discovered.data
                .find((entry) => entry.cwd === workspace)!
                .skills.filter((skill) =>
                  ['gestalt:coding', 'gestalt:xerj', 'gestalt:serena'].includes(skill.name),
                )
                .map(({ name, enabled }) => ({ name, enabled }))
                .sort((a, b) => a.name.localeCompare(b.name));
              expect(fixtureSkills).toEqual([
                { name: 'gestalt:coding', enabled: true },
                { name: 'gestalt:serena', enabled: false },
                { name: 'gestalt:xerj', enabled: false },
              ]);
            }
            return result;
          },
          onNotification: native.onNotification.bind(native),
          onServerRequest: native.onServerRequest.bind(native),
        },
      };
      processes.push(server);
      return server;
    };
    const pair = new CodexCapabilities(
      new CodexXerj({ check: async () => ({ status: 'absent' }) }),
      new CodexSerena({ check: async () => ({ status: 'absent' }) }),
    );
    const session = {
      ...RelaySession.create({
        id: 'fixture',
        provider: 'codex',
        workspaceId: 'w',
        workspacePath: workspace,
        profile: 'default',
        model: 'fixture',
        effectiveSkillSelection: profileCase
          ? { selectedProfileName: skillProfile.name, skills: skillProfile.skills }
          : { skills: [] },
        now: 't',
      }).snapshot,
      executionPolicy: { approvalPolicy: 'never' as const, sandbox: 'read-only' as const },
    };
    for (const wrapped of [false, true]) {
      const runtime = new CodexSessionRuntime(
        open,
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
        undefined,
        undefined,
        wrapped || profileCase
          ? {
              prepare: async (activeSession, rpc, config, deadline) => {
                const catalog = (await rpc.request('skills/list', {
                  cwds: [workspace],
                  forceReload: true,
                })) as { data: Array<{ cwd: string; skills: AvailableSkill[] }> };
                // Keep the stable selection fields used by CodexSkillCatalog;
                // native wire-only metadata is not a domain selection entry.
                const skills = catalog.data
                  .find((entry) => entry.cwd === workspace)!
                  .skills.map(({ name, path, enabled }) => ({ name, path, enabled }));
                const selected = profileCase
                  ? compileSkillOverride({
                      discovered: skills,
                      explicit: activeSession.effectiveSkillSelection?.skills,
                      project: skillProfile.skills.map((skill) => ({ ...skill, enabled: false })),
                    })
                  : { skillsConfig: skills.map(({ path, enabled }) => ({ path, enabled })) };
                if (profileCase) {
                  expect(activeSession.profile).toBe('default');
                  expect(activeSession.effectiveSkillSelection?.selectedProfileName).toBe(
                    'fixture-review',
                  );
                  expect(selected).toMatchObject({ source: 'explicit', warnings: [] });
                  expect(selected.skillsConfig).toContainEqual({
                    path: optionalSkillPath,
                    enabled: true,
                  });
                  expect(selected.skillsConfig).toContainEqual({
                    path: join(installed, 'skills/coding/SKILL.md'),
                    enabled: true,
                  });
                  expect(selected.skillsConfig).toContainEqual({
                    path: join(installed, 'skills/xerj/SKILL.md'),
                    enabled: false,
                  });
                  expect(selected.skillsConfig).toContainEqual({
                    path: join(installed, 'skills/serena/SKILL.md'),
                    enabled: false,
                  });
                }
                // The native baseline uses the identical Mobile profile mask, without
                // startup/capability additions. All native instruction bytes remain comparable.
                if (!wrapped)
                  return {
                    config,
                    skillsConfig: selected.skillsConfig,
                    ready: false,
                    deadline,
                    fallback() {},
                  };
                const state = await pair.prepare({
                  cwd: workspace,
                  rpc:
                    mode === 'readback-failure'
                      ? {
                          request: async (method, params) => {
                            if (method === 'config/read')
                              throw new Error('Synthetic readback unavailable');
                            return rpc.request(method, params);
                          },
                        }
                      : rpc,
                  config,
                  deadline,
                  start: true,
                  startup: !activeSession.threadId,
                  skills,
                  skillsConfig: selected.skillsConfig,
                });
                expect(state.startup).toMatchObject(
                  mode === 'readback-failure'
                    ? { status: 'unavailable', reason: 'native-config-unavailable' }
                    : {
                        status: mode === 'older-package' ? 'unavailable' : 'ready',
                        packageVersion: '0.0.1',
                      },
                );
                return state;
              },
              verify: (rpc, thread, state) => pair.verify(rpc, thread, state),
            }
          : undefined,
      );
      runtimes.push(runtime);
      const started = await runtime.start(session, 't');
      const turn = await runtime.startTurn(started, 'SYNTHETIC_STARTUP_PROBE', undefined, 'u');
      await vi.waitFor(() => expect(completed.has(turn.activeTurnId!)).toBe(true), {
        timeout: 15_000,
      });
      await runtime.release(session.id);
    }
    expect(captures).toHaveLength(2);
    const [baseline, delivered] = captures;
    const text = components(delivered).join('\n');
    expect(digest(delivered.instructions ?? '')).toBe(digest(baseline.instructions ?? ''));
    for (const { role, text: component } of roleComponents(baseline))
      expect(
        roleComponents(delivered)
          .filter((item) => item.role === role)
          .reduce((total, item) => total + count(item.text, component), 0),
      ).toBe(1);
    if (scalar) expect(count(text, scalar)).toBe(1);
    if (profileCase) {
      expect(count(text, 'CUSTOM_NATIVE_GUIDANCE')).toBe(1);
      expect(count(text, 'ROLE_ONLY_DUTIES')).toBe(1);
      expect(text).toContain('fixture-review');
    }
    expect(JSON.stringify(delivered.input)).toContain('REPOSITORY_NATIVE_GUIDANCE');
    const expectedBlocks = mode === 'older-package' || mode === 'readback-failure' ? 0 : 1;
    expect(count(text, syntheticBootstrap)).toBe(expectedBlocks);
    const params = sent.filter((request) => request.method === 'thread/start').at(-1)!.params as {
      config: Record<string, unknown>;
    };
    expect(params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      model: 'fixture',
    });
    expect(params).not.toHaveProperty('baseInstructions');
    expect(params).not.toHaveProperty('developerInstructions');
    expect(params.config).not.toHaveProperty('personality');
    expect(params.config).not.toHaveProperty('model_instructions_file');
    if (profileCase) {
      const sentSkills = (
        params.config.skills as { config: Array<{ path?: string; enabled: boolean }> }
      ).config;
      expect(sentSkills.filter((entry) => entry.path === optionalSkillPath)).toEqual([
        { path: optionalSkillPath, enabled: true },
      ]);
      expect(sentSkills).toContainEqual({
        path: join(installed, 'skills/coding/SKILL.md'),
        enabled: true,
      });
      expect(sentSkills).toContainEqual({
        path: join(installed, 'skills/xerj/SKILL.md'),
        enabled: false,
      });
      expect(sentSkills).toContainEqual({
        path: join(installed, 'skills/serena/SKILL.md'),
        enabled: false,
      });
    }
    if (mode === 'readback-failure')
      expect(params.config).not.toHaveProperty('developer_instructions');
    expect(count(String(params.config.developer_instructions), syntheticBootstrap)).toBe(
      expectedBlocks,
    );
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(originalConfig);
  },
  60_000,
);

it.skipIf(process.env.RUN_INSTALLED_CODEX !== '1')(
  'native CLI profile selector rejects app-server before model delivery',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mobile native profile boundary '));
    const home = join(root, 'home');
    await mkdir(home);
    let modelRequests = 0;
    const model = createServer((_request, response) => {
      modelRequests++;
      response.writeHead(500).end();
    });
    onTestFinished(async () => {
      model.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        model.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as { port: number }).port;
    const config = `model='fixture'\nmodel_provider='fixture'\napproval_policy='never'\n${providerConfig(port)}`;
    const layer = "developer_instructions='SYNTHETIC_NATIVE_PROFILE_LAYER'\n";
    await writeFile(join(home, 'config.toml'), config);
    await writeFile(join(home, 'fixture.config.toml'), layer);
    const version = await run('codex', ['--version'], {
      env: { ...process.env, CODEX_HOME: home },
      cwd: root,
      timeout: 5_000,
    });
    const observedVersion = /\b\d+\.\d+\.\d+\b/u.exec(version.stdout)?.[0] ?? 'unknown';
    const result = await run('codex', ['--profile', 'fixture', 'app-server', '--stdio'], {
      env: { ...process.env, CODEX_HOME: home },
      cwd: root,
      timeout: 5_000,
    }).then(
      () => ({ exitCode: 0, unsupportedSelector: false }),
      (error: { code?: unknown; stderr?: unknown }) => ({
        exitCode: typeof error.code === 'number' ? error.code : null,
        unsupportedSelector:
          typeof error.stderr === 'string' &&
          error.stderr
            .replaceAll('`', '')
            .includes(
              '--profile only applies to runtime commands, codex mcp, and codex migrate-nfs-db',
            ),
      }),
    );
    expect(result).toEqual({ exitCode: 1, unsupportedSelector: true });
    expect(modelRequests).toBe(0);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(config);
    expect(await readFile(join(home, 'fixture.config.toml'), 'utf8')).toBe(layer);
    console.info(
      'startup-native-selector-boundary ' +
        JSON.stringify({ observedVersion, ...result, modelRequests }),
    );
  },
  15_000,
);
