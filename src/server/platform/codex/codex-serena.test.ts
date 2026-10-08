/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexSessionRuntime } from './session-runtime.js';
import {
  RelaySession,
  createEffectiveSkillSelection,
  type RelaySessionSnapshot,
} from '../../features/sessions/model/relay-session.js';
import { CodexSerena, serenaServerName } from './codex-serena.js';
import { ManagedSerena, serenaTools } from './managed-serena.js';
import { CodexCapabilities } from './codex-capabilities.js';
import { CodexXerj, xerjServerName, xerjTools } from '../retrieval/codex-xerj.js';
import {
  applySkillSelectionSnapshot,
  compileSkillOverride,
  createSkillProfile,
} from '../../features/skills/model/skill-profile.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mobile-serena spaces '));
  roots.push(root);
  const home = join(root, 'installation');
  await mkdir(join(home, 'serena'), { recursive: true });
  await mkdir(join(home, 'python'));
  const manager = join(root, 'gestalt');
  await writeFile(manager, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const descriptor = {
    schemaVersion: 1,
    contractVersion: 1,
    version: '1.7.0',
    executable: manager,
    python: manager,
    uv: manager,
    pythonInstallDir: join(home, 'python'),
    pythonExecutables: [manager],
    tools: serenaTools.map((name) => ({ name, inputSchema: { type: 'object' } })),
  };
  const descriptorPath = join(home, 'serena', 'active.json');
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const skillPath = join(root, 'SKILL.md');
  await writeFile(skillPath, '# Serena\nUse semantic tools with current-source verification.');
  const xerjPath = join(root, 'XERJ.md');
  await writeFile(xerjPath, '# XERJ\nRead current source.');
  const skills = [
    { name: 'gestalt:serena', path: skillPath, enabled: true },
    { name: 'gestalt:xerj', path: xerjPath, enabled: false },
  ];
  const native: Record<string, unknown> = {
    features: { hooks: true },
    developer_instructions: 'Keep guidance.',
    mcp_servers: {
      unrelated: { command: 'unrelated' },
      alias: { command: manager, args: ['serena', 'mcp'] },
    },
  };
  const rpc = {
    request: vi.fn(async (method: string) =>
      method === 'config/read'
        ? { config: native }
        : {
            data: [
              {
                name: serenaServerName,
                runtimeStatus: 'connected',
                tools: Object.fromEntries(serenaTools.map((tool) => [tool, {}])),
              },
              {
                name: xerjServerName,
                runtimeStatus: 'connected',
                tools: Object.fromEntries(xerjTools.map((tool) => [tool, {}])),
              },
            ],
          },
    ),
  };
  const installed = new ManagedSerena({ GESTALT_HOME: home, GESTALT_MANAGER_BIN: manager });
  const adapter = new CodexSerena(installed);
  const input = {
    cwd: root,
    deadline: Date.now() + 1000,
    rpc,
    skills,
    skillsConfig: compileSkillOverride({ discovered: skills }).skillsConfig,
    approvalPolicy: 'never',
    config: { approval_policy: 'never', sandbox_mode: 'read-only' },
    start: true,
  };
  return {
    root,
    home,
    manager,
    descriptor,
    descriptorPath,
    skillPath,
    installed,
    adapter,
    input,
    native,
    rpc,
  };
}

describe('workspace-bound Serena capability', () => {
  it.each(['missing installation', 'excluded skill', 'undiscovered skill'])(
    'keeps session configuration valid with %s and no native Serena server',
    async (scenario) => {
      const f = await fixture();
      f.native.mcp_servers = {};
      await rm(f.descriptorPath);
      const skills = scenario === 'undiscovered skill' ? [] : f.input.skills;
      const skillsConfig = compileSkillOverride({
        discovered: skills,
        explicit:
          scenario === 'excluded skill'
            ? skills.map((skill) => ({ ...skill, enabled: false }))
            : undefined,
      }).skillsConfig;
      const pair = new CodexCapabilities(
        new CodexXerj({ check: async () => ({ status: 'absent' }) }),
        f.adapter,
      );
      const state = await pair.prepare({ ...f.input, skills, skillsConfig });
      expect(state.ready).toBe(false);
      // Codex validates transport even for disabled servers. The override also
      // disables an earlier thread connection when these settings are resumed.
      expect(state.config).toMatchObject({
        mcp_servers: {
          [serenaServerName]: {
            command: 'gestalt',
            args: ['serena', 'mcp', '--cwd', f.root],
            enabled: false,
            required: false,
          },
        },
      });
      expect(state.skillsConfig.find((skill) => skill.path === f.skillPath)?.enabled ?? false).toBe(
        false,
      );
      expect(f.rpc.request.mock.calls.every(([method]) => method === 'config/read')).toBe(true);
      await expect(access(join(f.root, '.gestalt'))).rejects.toThrow();
    },
  );

  it('validates shared immutable metadata without executing a manager or starting a language server', async () => {
    const f = await fixture();
    expect(await f.installed.check()).toEqual({
      status: 'installed',
      manager: f.manager,
      version: '1.7.0',
    });
    expect(JSON.parse(await readFile(f.descriptorPath, 'utf8'))).toEqual(f.descriptor);
    await expect(access(join(f.root, '.gestalt'))).rejects.toThrow();
  });
  it.each([
    { contractVersion: 2 },
    { version: 'dev' },
    { tools: [] },
    { python: 'relative' },
    { uv: '/missing' },
    { pythonInstallDir: '/missing' },
  ])('fails closed for invalid metadata %j', async (invalid) => {
    const f = await fixture();
    await writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, ...invalid }));
    expect((await f.installed.check()).status).not.toBe('installed');
    const state = await f.adapter.prepare(f.input);
    expect(state.ready).toBe(false);
    expect(state.skillsConfig.find((skill) => skill.path === f.skillPath)?.enabled).toBe(false);
  });
  it('binds equal basenames and narrowed child workspaces independently without changing readonly policy', async () => {
    const f = await fixture();
    const workspaces = [
      join(f.root, 'a', 'project'),
      join(f.root, 'b', 'project'),
      join(f.root, 'a', 'project', 'child'),
    ];
    for (const cwd of workspaces) {
      await mkdir(cwd, { recursive: true });
      const state = await f.adapter.prepare({ ...f.input, cwd });
      expect(state.ready).toBe(true);
      expect(state.config).toMatchObject({
        approval_policy: 'never',
        sandbox_mode: 'read-only',
        mcp_servers: {
          alias: { enabled: false },
          [serenaServerName]: { cwd, args: ['serena', 'mcp', '--cwd', cwd], required: false },
        },
      });
      const config = (state.config.mcp_servers as Record<string, Record<string, unknown>>)[
        serenaServerName
      ];
      expect(config.default_tools_approval_mode).toBe('approve');
      expect(config).not.toHaveProperty('env');
      expect(config).not.toHaveProperty('enabled_tools');
      expect(await f.adapter.verify(f.rpc, 'native-thread', state)).toBe(true);
      await expect(access(join(cwd, '.gestalt'))).rejects.toThrow();
    }
    expect(f.rpc.request.mock.calls.some(([method]) => method === 'mcpServer/tool/call')).toBe(
      false,
    );
    expect((await f.adapter.prepare(f.input)).config.developer_instructions).toContain(
      'do not prove language readiness',
    );
  });
  it.each(['on-request', 'untrusted'])(
    'keeps interactive approvals for %s',
    async (approvalPolicy) => {
      const f = await fixture();
      const state = await f.adapter.prepare({ ...f.input, approvalPolicy });
      expect(
        (state.config.mcp_servers as Record<string, Record<string, unknown>>)[serenaServerName],
      ).not.toHaveProperty('default_tools_approval_mode');
    },
  );
  it.each(['prompt', 'auto', 'writes'])('preserves explicit server approval %s', async (mode) => {
    const f = await fixture();
    (f.native.mcp_servers as Record<string, unknown>)[serenaServerName] = {
      default_tools_approval_mode: mode,
    };
    const state = await f.adapter.prepare(f.input);
    expect(
      (state.config.mcp_servers as Record<string, Record<string, unknown>>)[serenaServerName]
        .default_tools_approval_mode,
    ).toBe(mode);
  });
  it('preserves explicit operator per-tool approvals without copying XERJ autoapproval', async () => {
    const f = await fixture();
    const approvals = {
      default_tools_approval_mode: 'approve',
      tools: { replace_symbol_body: { approval_mode: 'prompt' } },
    };
    (f.native.mcp_servers as Record<string, unknown>)[serenaServerName] = approvals;
    const state = await f.adapter.prepare(f.input);
    expect(state.ready).toBe(true);
    expect((state.config.mcp_servers as Record<string, unknown>)[serenaServerName]).toMatchObject(
      approvals,
    );
    state.fallback();
    expect((state.config.mcp_servers as Record<string, unknown>)[serenaServerName]).toMatchObject({
      ...approvals,
      enabled: false,
    });
  });
  it('omits unset native readback defaults from start and fallback while preserving approvals', async () => {
    const f = await fixture();
    const readback = {
      command: f.manager,
      args: ['serena', 'mcp', '--cwd', f.root],
      environment_id: 'local',
      enabled: true,
      tool_timeout_sec: null,
      env: null,
      disabled_tools: undefined,
      default_tools_approval_mode: 'approve',
      tools: { replace_symbol_body: { enabled: null, approval_mode: 'prompt' } },
    };
    (f.native.mcp_servers as Record<string, unknown>)[serenaServerName] = readback;
    (f.native.mcp_servers as Record<string, unknown>).alias = readback;
    const state = await f.adapter.prepare(f.input);
    expect(state.ready).toBe(true);
    for (const fallback of [false, true]) {
      if (fallback) state.fallback();
      const servers = state.config.mcp_servers as Record<string, Record<string, unknown>>;
      for (const name of [serenaServerName, 'alias']) {
        expect(servers[name]).not.toHaveProperty('tool_timeout_sec');
        expect(servers[name]).not.toHaveProperty('env');
        expect(servers[name]).not.toHaveProperty('disabled_tools');
        expect(servers[name].default_tools_approval_mode).toBe('approve');
        expect(servers[name].tools).toEqual({ replace_symbol_body: { approval_mode: 'prompt' } });
      }
      expect(servers[serenaServerName].enabled).toBe(!fallback);
      expect(servers.alias.enabled).toBe(false);
    }
    expect(readback.tool_timeout_sec).toBeNull();
    expect(readback.tools.replace_symbol_body.enabled).toBeNull();
  });
  it.each(['native-rule', 'hooks', 'tool-conflict', 'instructions'])(
    'does not advertise capability when excluded by %s',
    async (exclusion) => {
      const f = await fixture();
      if (exclusion === 'native-rule')
        f.native.skills = { config: [{ name: 'gestalt:serena', enabled: false }] };
      if (exclusion === 'hooks') f.native.features = { hooks: false };
      if (exclusion === 'tool-conflict')
        (f.native.mcp_servers as Record<string, unknown>)[serenaServerName] = {
          tools: { replace_symbol_body: { enabled: true } },
        };
      if (exclusion === 'instructions') f.native.skills = { include_instructions: false };
      const state = await f.adapter.prepare(f.input);
      expect(state.ready).toBe(false);
      expect(state.config.developer_instructions).toContain('Earlier Serena guidance is inactive');
    },
  );
  it('loads healthy Serena automatically even with empty or legacy disabled selections', async () => {
    const f = await fixture();
    const skills = [
      ...f.input.skills,
      { name: 'gestalt:org-plan', path: '/org/SKILL.md', enabled: true },
    ];
    expect(createSkillProfile({ name: 'optional', skills }).skills).toEqual([]);
    expect(
      applySkillSelectionSnapshot(skills, []).find((skill) => skill.name === 'gestalt:serena')
        ?.enabled,
    ).toBe(true);
    for (const skillsConfig of [[], [{ path: f.skillPath, enabled: false }]]) {
      const state = await f.adapter.prepare({ ...f.input, skillsConfig });
      expect(state.ready).toBe(true);
      expect(state.skillsConfig).toContainEqual({ path: f.skillPath, enabled: true });
      expect(state.config.developer_instructions).toContain('<gestalt_serena_capability>');
    }
    expect(
      applySkillSelectionSnapshot(skills, []).find((skill) => skill.name === 'gestalt:org-plan')
        ?.enabled,
    ).toBe(true);
  });
  it.each(['xerj', 'serena'] as const)(
    'retains the other connection after %s fails at verification',
    async (failure) => {
      const f = await fixture();
      const xerj = new CodexXerj({
        check: async () => ({
          status: 'ready',
          manager: f.manager,
          endpoint: 'http://127.0.0.1:19200',
        }),
      });
      const pair = new CodexCapabilities(xerj, f.adapter);
      const state = await pair.prepare(f.input);
      const badRpc = {
        request: async () => ({
          data: [
            {
              name: xerjServerName,
              runtimeStatus: failure === 'xerj' ? 'failed' : 'connected',
              tools: Object.fromEntries(xerjTools.map((tool) => [tool, {}])),
            },
            {
              name: serenaServerName,
              runtimeStatus: failure === 'serena' ? 'failed' : 'connected',
              tools: Object.fromEntries(serenaTools.map((tool) => [tool, {}])),
            },
          ],
        }),
      };
      expect(await pair.verify(badRpc, 'thread', state)).toBe(false);
      state.fallback();
      expect(state.ready).toBe(true);
      expect(state.capabilities?.find((cap) => cap.skillName === `gestalt:${failure}`)?.ready).toBe(
        false,
      );
      expect(state.capabilities?.find((cap) => cap.skillName !== `gestalt:${failure}`)?.ready).toBe(
        true,
      );
      expect(state.config).toMatchObject({ approval_policy: 'never', sandbox_mode: 'read-only' });
      expect(state.config.developer_instructions).toContain('Keep guidance.');
    },
  );
  it('retains a healthy Serena connection when slow XERJ preparation exhausts its deadline', async () => {
    const f = await fixture();
    const deadline = Date.now() + 75;
    const xerj = new CodexXerj({
      check: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: 'unavailable', reason: 'readiness-timeout' };
      },
    });
    const prepareXerj = vi.spyOn(xerj, 'prepare');
    const verifyXerj = vi.spyOn(xerj, 'verify');
    const pair = new CodexCapabilities(xerj, f.adapter);
    const state = await pair.prepare({ ...f.input, deadline });
    expect((await prepareXerj.mock.results[0].value).deadline).toBe(deadline);
    expect(Date.now()).toBeGreaterThan(deadline);
    expect(state.deadline).toBeGreaterThan(Date.now());
    expect(state.deadline).toBeLessThanOrEqual(Date.now() + 75);
    expect(await pair.verify(f.rpc, 'thread', state)).toBe(true);
    expect(state.capabilities).toMatchObject([{ ready: false }, { ready: true }]);
    expect(verifyXerj).not.toHaveBeenCalled();
    expect(state.skillsConfig.find((skill) => skill.path === f.skillPath)?.enabled).toBe(true);
    expect(state.config).toMatchObject({ approval_policy: 'never', sandbox_mode: 'read-only' });
    const statusRequests = f.rpc.request.mock.calls.filter(
      ([method]) => method === 'mcpServerStatus/list',
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await pair.verify(f.rpc, 'thread', state)).toBe(false);
    expect(
      f.rpc.request.mock.calls.filter(([method]) => method === 'mcpServerStatus/list'),
    ).toHaveLength(statusRequests);
  });

  it('preserves Serena when XERJ is absent and XERJ when Serena is absent', async () => {
    const f = await fixture();
    const noXerj = new CodexCapabilities(
      new CodexXerj({ check: async () => ({ status: 'absent' }) }),
      f.adapter,
    );
    expect((await noXerj.prepare(f.input)).capabilities).toMatchObject([
      { ready: false },
      { ready: true },
    ]);
    await rm(f.descriptorPath);
    const noSerena = new CodexCapabilities(
      new CodexXerj({
        check: async () => ({
          status: 'ready',
          manager: f.manager,
          endpoint: 'http://127.0.0.1:19200',
        }),
      }),
      f.adapter,
    );
    expect((await noSerena.prepare(f.input)).capabilities).toMatchObject([
      { ready: true },
      { ready: false },
    ]);
  });
  it('falls back when native catalog is stale or the optional LSP connection fails', async () => {
    const f = await fixture();
    const state = await f.adapter.prepare(f.input);
    expect(
      await f.adapter.verify(
        {
          request: async () => ({
            data: [
              {
                name: serenaServerName,
                runtimeStatus: 'connected',
                toolsError: 'private language failure',
              },
            ],
          }),
        },
        'thread',
        state,
      ),
    ).toBe(false);
    state.fallback();
    expect(state.ready).toBe(false);
    expect(JSON.stringify(state)).not.toContain('private language failure');
  });
});

describe('Serena runtime boundaries', () => {
  it('recomputes start, restore and recovery without overriding child authority, and closes only owned writers', async () => {
    const f = await fixture();
    const pair = new CodexCapabilities(
      new CodexXerj({ check: async () => ({ status: 'absent' }) }),
      f.adapter,
    );
    const requests: Array<{ method: string; params: unknown }> = [];
    const close = vi.fn();
    let starts = 0;
    const rpc = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: `thread-${++starts}` } };
        if (method === 'turn/start') return { turn: { id: 'turn' } };
        return f.rpc.request(method);
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    };
    const prepare = vi.fn(async (session: RelaySessionSnapshot, activeRpc, config, deadline) =>
      pair.prepare({
        ...f.input,
        cwd: session.workspacePath,
        rpc: activeRpc,
        config,
        deadline,
        skillsConfig: compileSkillOverride({
          discovered: f.input.skills,
          explicit: session.effectiveSkillSelection?.skills,
        }).skillsConfig,
      }),
    );
    const notifications = vi.fn();
    const runtime = new CodexSessionRuntime(
      () => ({ rpc, close }),
      undefined,
      notifications,
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
      { prepare, verify: (activeRpc, threadId, state) => pair.verify(activeRpc, threadId, state) },
    );
    const initial = {
      ...RelaySession.create({
        id: 's',
        provider: 'codex',
        workspaceId: 'w',
        workspacePath: f.root,
        profile: 'default',
        now: 't',
        effectiveSkillSelection: { skills: f.input.skills },
      }).snapshot,
      executionPolicy: { approvalPolicy: 'never' as const, sandbox: 'read-only' as const },
    };
    const started = await runtime.start(initial, 't');
    expect(notifications).toHaveBeenCalledWith(
      initial.id,
      {
        method: 'mcpServer/statusUpdated',
        params: { name: 'gestalt-serena', status: 'connected' },
      },
      { kind: 'root' },
    );
    expect(
      started.effectiveSkillSelection?.skills.find((skill) => skill.name === 'gestalt:serena')
        ?.enabled,
    ).toBe(true);
    expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
      cwd: f.root,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: { mcp_servers: { [serenaServerName]: { args: ['serena', 'mcp', '--cwd', f.root] } } },
    });
    await runtime.startTurn(started, 'inspect current source', undefined, 'u');
    await runtime.startExecutorTurn(started, 'narrow-child', 'inspect child source', 'message');
    expect(
      requests.find(
        (request) =>
          request.method === 'turn/start' &&
          (request.params as { threadId: string }).threadId === 'narrow-child',
      )?.params,
    ).not.toHaveProperty('sandbox');
    expect(
      requests.find(
        (request) =>
          request.method === 'turn/start' &&
          (request.params as { threadId: string }).threadId === 'narrow-child',
      )?.params,
    ).not.toHaveProperty('config');
    await runtime.release(started.id);
    const restored = await runtime.restore(started, 'v');
    expect(restored.threadId).toBe(started.threadId);
    await rm(f.descriptorPath);
    const recovered = await runtime.recycle(restored, 'w');
    expect(
      recovered.effectiveSkillSelection?.skills.find((skill) => skill.name === 'gestalt:serena')
        ?.enabled,
    ).toBe(false);
    expect(recovered.effectiveSkillSelection?.serenaSelected).toBeUndefined();
    expect(recovered.effectiveSkillSelection?.warnings).toContain(
      'Serena is unavailable in this session. Use native code tools. Connection availability will be checked when the runtime resumes.',
    );
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(
      requests.filter((request) => request.method === 'thread/resume').at(-1)?.params,
    ).toMatchObject({
      cwd: f.root,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: { mcp_servers: { [serenaServerName]: { enabled: false } } },
    });
    expect(requests.some((request) => request.method === 'mcpServer/tool/call')).toBe(false);
    await writeFile(f.descriptorPath, JSON.stringify(f.descriptor));
    const availableAgain = await runtime.recycle(recovered, 'x');
    expect(
      availableAgain.effectiveSkillSelection?.skills.find(
        (skill) => skill.name === 'gestalt:serena',
      )?.enabled,
    ).toBe(true);
    expect(availableAgain.effectiveSkillSelection?.warnings ?? []).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(4);
    // Empty and legacy disabled selections cannot suppress a healthy automatic capability.
    const excludedSelection = createEffectiveSkillSelection({
      selectedProfileName: 'exclude',
      skills: f.input.skills.map((skill) => ({ ...skill, enabled: false })),
    });
    expect(excludedSelection).not.toHaveProperty('serenaSelected');
    const excluded = await runtime.recycle(
      {
        ...availableAgain,
        effectiveSkillSelection: { ...excludedSelection, serenaSelected: false },
      },
      'y',
    );
    expect(excluded.effectiveSkillSelection?.serenaSelected).toBe(false); // Legacy metadata is ignored.
    expect(
      excluded.effectiveSkillSelection?.skills.find((skill) => skill.name === 'gestalt:serena')
        ?.enabled,
    ).toBe(true);
    expect(
      requests.filter((request) => request.method === 'thread/resume').at(-1)?.params,
    ).toMatchObject({ config: { mcp_servers: { [serenaServerName]: { enabled: true } } } });
    const enabledSelection = createEffectiveSkillSelection({
      selectedProfileName: 'include',
      skills: f.input.skills,
    });
    const selectedAgain = await runtime.recycle(
      { ...excluded, effectiveSkillSelection: enabledSelection },
      'z',
    );
    expect(selectedAgain.effectiveSkillSelection?.serenaSelected).toBeUndefined();
    expect(
      selectedAgain.effectiveSkillSelection?.skills.find((skill) => skill.name === 'gestalt:serena')
        ?.enabled,
    ).toBe(true);
    runtime.stopAll();
    expect(close).toHaveBeenCalledTimes(6);
  });
});
