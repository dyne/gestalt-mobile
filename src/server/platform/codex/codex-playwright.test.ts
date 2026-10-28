/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexPlaywright, type PlaywrightAuthority } from './codex-playwright.js';
import {
  ManagedPlaywright,
  playwrightServerName,
  playwrightTools,
  type PlaywrightReadiness,
} from './managed-playwright.js';
import type { CodexRetrievalState } from '../retrieval/codex-xerj.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import { compileSkillOverride } from '../../features/skills/model/skill-profile.js';
import { CodexCapabilities } from './codex-capabilities.js';
import type { CodexXerj } from '../retrieval/codex-xerj.js';
import type { CodexSerena } from './codex-serena.js';

const roots: string[] = [];
const healthyReadiness: PlaywrightReadiness = {
  ready: true,
  package: 'ready',
  chrome: 'ready',
  node: 'ready',
  chromeVersion: '151.0.7872.0',
};
const missingChrome: PlaywrightReadiness = {
  ...healthyReadiness,
  ready: false,
  chrome: 'unavailable',
  chromeVersion: null,
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mobile-playwright spaces '));
  roots.push(root);
  const skillPath = join(root, 'SKILL.md');
  await writeFile(skillPath, '# Browser\nUse current snapshots.');
  const session = {
    id: 'session-a',
    threadId: 'root-a',
    workspacePath: root,
    provider: 'codex',
    effectiveSkillSelection: { capabilities: { playwright: { enabled: true } } },
  } as RelaySessionSnapshot;
  const authority: PlaywrightAuthority = {
    session,
    planIdentity: 'retained-plan-a',
    activePlanId: 'l5',
    declared: false,
    fenced: false,
  };
  const installation = {
    check: vi.fn(async () => ({
      status: 'installed' as const,
      manager: '/operator/gestalt',
      version: '0.0.83',
    })),
    ready: vi.fn(async () => healthyReadiness),
  };
  const adapter = new CodexPlaywright(installation);
  const native: Record<string, unknown> = { mcp_servers: {}, skills: {} };
  const tools: Record<string, unknown> = Object.fromEntries(
    playwrightTools.map((tool) => [tool, {}]),
  );
  const rpc = {
    request: vi.fn(async (method: string) =>
      method === 'config/read'
        ? { config: native }
        : { data: [{ name: playwrightServerName, runtimeStatus: 'connected', tools }] },
    ),
  };
  const base: CodexRetrievalState = {
    ready: true,
    config: {
      mcp_servers: { unrelated: { command: 'keep' } },
      developer_instructions: 'Keep unrelated rules.',
    },
    skillsConfig: [{ path: skillPath, enabled: true }],
    deadline: Date.now() + 1000,
    capabilities: [{ skillName: 'gestalt:serena', serverName: 'gestalt-serena', ready: true }],
    fallback: vi.fn(),
  };
  const skills = [{ name: 'gestalt:playwright', path: skillPath, enabled: false }];
  const prepare = () =>
    adapter.prepare(base, authority, { rpc, skills, deadline: Date.now() + 1000 });
  const control = (action: string, extra: object = {}) =>
    adapter.control(authority, { capability: 'playwright', action, ...extra }, true);
  return {
    root,
    authority,
    installation,
    adapter,
    native,
    rpc,
    base,
    skills,
    tools,
    prepare,
    control,
  };
}

describe('managed Mobile Playwright session', () => {
  it.each([
    {},
    { playwright: { enabled: 'true' } },
    { playwright: { enabled: true }, unknown: true },
  ])('rejects malformed persisted consent %j', async (capabilities) => {
    const f = await fixture();
    f.authority.session = {
      ...f.authority.session,
      effectiveSkillSelection: {
        ...f.authority.session.effectiveSkillSelection!,
        capabilities: capabilities as never,
      },
    };
    f.authority.declared = true;
    expect(await f.control('start')).toMatchObject({ status: 'off' });
    await f.prepare();
    expect(f.installation.check).not.toHaveBeenCalled();
  });
  it('keeps opted-in idle sessions process-free and browser guidance disabled', async () => {
    const f = await fixture();
    const state = await f.prepare();
    expect(f.installation.check).not.toHaveBeenCalled();
    expect(f.installation.ready).not.toHaveBeenCalled();
    expect(state.config.mcp_servers).toMatchObject({
      [playwrightServerName]: { enabled: false },
      unrelated: { command: 'keep' },
    });
    expect(state.skillsConfig[0]?.enabled).toBe(false);
    expect(state.turnInstructions).toBe('');
    expect(await f.control('status')).toMatchObject({ status: 'idle' });
    expect(await f.control('status')).toMatchObject({
      packageStatus: 'unknown',
      chrome: { status: 'unknown', version: null },
      readinessObservedAt: null,
    });
    expect(f.installation.ready).not.toHaveBeenCalled();
  });
  it('does not require filesystem readiness to dispatch an unrequested browser-off root turn', async () => {
    const f = await fixture();
    f.authority.session = {
      ...f.authority.session,
      workspacePath: '/nonexistent/browser-off-workspace',
      effectiveSkillSelection: undefined,
    };
    expect(f.adapter.needsResume(f.authority)).toBe(false);
    expect(f.installation.check).not.toHaveBeenCalled();
    expect(f.installation.ready).not.toHaveBeenCalled();
  });
  it.each(['legacy', 'disabled', 'kimi'])(
    'rejects %s consent even with a declaration and explicit request',
    async (mode) => {
      const f = await fixture();
      f.authority.declared = true;
      f.authority.session = {
        ...f.authority.session,
        ...(mode === 'kimi'
          ? { provider: 'kimi' }
          : {
              effectiveSkillSelection:
                mode === 'legacy'
                  ? undefined
                  : {
                      ...f.authority.session.effectiveSkillSelection!,
                      capabilities: { playwright: { enabled: false } },
                    },
            }),
      };
      expect(await f.control('start')).toMatchObject({ status: 'off' });
      await f.prepare();
      expect(f.installation.check).not.toHaveBeenCalled();
    },
  );
  it.each([
    { capability: 'unknown', action: 'start' },
    { capability: 'playwright', action: 'exec' },
    { capability: 'playwright', action: 'start', command: 'curl' },
    { capability: 'playwright', action: 'start', env: {} },
    { capability: 'playwright', action: 'start', sessionId: 'other' },
    { capability: 'playwright', action: 'start', executablePath: '/bin/sh' },
  ])('rejects unknown and injected requests: %j', async (arguments_) => {
    const f = await fixture();
    expect(await f.adapter.control(f.authority, arguments_, true)).toMatchObject({
      status: 'unavailable',
    });
    expect(f.installation.check).not.toHaveBeenCalled();
  });
  it('rejects forged child and foreign-plan requests', async () => {
    const f = await fixture();
    expect(
      await f.adapter.control(f.authority, { capability: 'playwright', action: 'start' }, false),
    ).toMatchObject({ status: 'unavailable' });
    expect(await f.control('start', { planId: 'other' })).toMatchObject({
      reason: 'unknown-plan-id',
    });
    expect(await f.adapter.needsResume(f.authority)).toBe(false);
  });
  it('activates only at the owned boundary, verifies tools, and preserves approvals', async () => {
    const f = await fixture();
    f.native.mcp_servers = {
      [playwrightServerName]: {
        default_tools_approval_mode: 'prompt',
        tools: { browser_navigate: { approval_mode: 'prompt' } },
      },
    };
    expect(await f.control('start')).toMatchObject({
      status: 'pending',
      boundary: 'owned-runtime-resume',
    });
    expect(f.installation.check).not.toHaveBeenCalled();
    expect(await f.adapter.needsResume(f.authority)).toBe(true);
    const state = await f.prepare();
    expect(state.turnInstructions).toBe('');
    expect(state.config.mcp_servers).toMatchObject({
      [playwrightServerName]: {
        command: '/operator/gestalt',
        args: ['playwright', 'mcp', '--cwd', f.root],
        enabled: true,
        default_tools_approval_mode: 'prompt',
        tools: { browser_navigate: { approval_mode: 'prompt' } },
        env_vars: ['GESTALT_HOME'],
      },
    });
    expect(await f.adapter.verify(f.rpc, 'root-a', state)).toBe(true);
    expect(state.turnInstructions).toContain('Use current snapshots.');
    expect(await f.control('status')).toMatchObject({ status: 'connected' });
    const status = await f.control('status');
    expect(status).toMatchObject({
      packageStatus: 'ready',
      chrome: { status: 'ready', version: '151.0.7872.0' },
      nodeStatus: 'ready',
      readinessObservedAt: expect.any(String),
    });
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(2048);
    expect(await f.control('start')).toMatchObject({ status: 'connected' });
    expect(await f.adapter.needsResume(f.authority)).toBe(false);
    expect(f.installation.ready).toHaveBeenCalledTimes(1);
  });
  it('releases idempotently and suppresses the declaration until ownership changes', async () => {
    const f = await fixture();
    f.authority.declared = true;
    const state = await f.prepare();
    await f.adapter.verify(f.rpc, 'root-a', state);
    expect(await f.control('stop')).toMatchObject({ status: 'pending' });
    expect(await f.adapter.needsResume(f.authority)).toBe(true);
    const stopped = await f.prepare();
    expect(stopped.config.mcp_servers).toMatchObject({
      [playwrightServerName]: { enabled: false },
    });
    expect(await f.control('stop')).toMatchObject({ status: 'idle' });
    f.adapter.release(f.authority.session.id);
    expect(await f.adapter.needsResume(f.authority)).toBe(true);
  });
  it.each(['manual-off', 'attention'])('does not activate behind the %s fence', async () => {
    const f = await fixture();
    f.authority.fenced = true;
    f.authority.declared = true;
    expect(await f.control('start')).toMatchObject({ reason: 'manual-off-or-attention' });
    await f.prepare();
    expect(f.installation.check).not.toHaveBeenCalled();
  });
  it.each(['session', 'root', 'workspace', 'plan'])(
    'does not inherit explicit ownership across a different %s',
    async (changed) => {
      const f = await fixture();
      await f.control('start');
      const other = { ...f.authority, session: { ...f.authority.session } };
      if (changed === 'session') other.session.id = 'session-b';
      if (changed === 'root') other.session.threadId = 'fork-b';
      if (changed === 'plan') other.planIdentity = 'plan-b';
      if (changed === 'workspace') {
        const path = join(f.root, 'other');
        await mkdir(path);
        other.session.workspacePath = path;
      }
      expect(await f.adapter.needsResume(other)).toBe(false);
    },
  );
  it.each([
    { enabled: false },
    { command: '/foreign' },
    { url: 'https://remote' },
    { env: { TOKEN: 'hidden' } },
    { env_vars: ['TOKEN'] },
    { args: ['playwright', 'mcp', '--cwd', '/other'] },
    { args: ['playwright', 'mcp', '--arbitrary', 'value'] },
  ])('preserves explicit native restrictions %j', async (config) => {
    const f = await fixture();
    f.native.mcp_servers = { [playwrightServerName]: config };
    await f.control('start');
    const state = await f.prepare();
    expect(state.config.mcp_servers).toMatchObject({ [playwrightServerName]: { enabled: false } });
    expect(f.installation.ready).not.toHaveBeenCalled();
  });
  it('supports a validated operator Chrome override without accepting tool-supplied paths', async () => {
    const f = await fixture();
    f.native.mcp_servers = {
      [playwrightServerName]: {
        args: ['playwright', 'mcp', '--executable-path', '/operator/chrome'],
      },
    };
    await f.control('start');
    await f.prepare();
    expect(f.installation.ready).toHaveBeenCalledWith(
      '/operator/gestalt',
      f.root,
      expect.any(Number),
      ['--executable-path', '/operator/chrome'],
    );
  });
  it.each(['missing', 'disabled', 'instructions-off'])(
    'keeps %s browser skill unavailable',
    async (mode) => {
      const f = await fixture();
      if (mode === 'missing') f.skills.splice(0);
      if (mode === 'disabled')
        f.native.skills = { config: [{ name: 'gestalt:playwright', enabled: false }] };
      if (mode === 'instructions-off') f.native.skills = { include_instructions: false };
      await f.control('start');
      const state = await f.prepare();
      expect(state.turnInstructions).toBe('');
      expect(f.installation.ready).not.toHaveBeenCalled();
    },
  );
  it('does not expose guidance for a connection missing required tools; other capabilities survive', async () => {
    const f = await fixture();
    delete f.tools.browser_fill_form;
    await f.control('start');
    const state = await f.prepare();
    expect(await f.adapter.verify(f.rpc, 'root-a', state)).toBe(false);
    expect(state.turnInstructions).toBe('');
    expect(state.ready).toBe(true);
    expect(
      state.capabilities?.find((capability) => capability.skillName === 'gestalt:serena')?.ready,
    ).toBe(true);
    expect(f.base.fallback).not.toHaveBeenCalled();
    expect(await f.control('status')).toMatchObject({ status: 'unavailable' });
  });
  it('keeps chat usable on doctor failure and deadline', async () => {
    const f = await fixture();
    f.installation.ready.mockResolvedValue(missingChrome);
    await f.control('start');
    const state = await f.prepare();
    expect(state.ready).toBe(true);
    expect(state.turnInstructions).toBe('');
    expect(await f.control('status')).toMatchObject({ status: 'unavailable' });
    expect(await f.control('status')).toMatchObject({
      packageStatus: 'ready',
      chrome: { status: 'unavailable', version: null },
      nodeStatus: 'ready',
    });
  });
  it('invalidates verification when consent or retained authority changes during the probe', async () => {
    const f = await fixture();
    await f.control('start');
    let current = f.authority;
    const state = await f.adapter.prepare(f.base, f.authority, {
      rpc: f.rpc,
      skills: f.skills,
      deadline: Date.now() + 1000,
      current: () => current,
    });
    current = { ...current, fenced: true };
    expect(await f.adapter.verify(f.rpc, 'root-a', state)).toBe(false);
    expect(state.turnInstructions).toBe('');
  });
  it('cannot promote disabled browser guidance through always-advertised skill rules', async () => {
    const f = await fixture();
    const compiled = compileSkillOverride({
      discovered: f.skills,
      explicit: f.skills.map((skill) => ({ ...skill, enabled: true })),
    });
    expect(compiled.skillsConfig[0]?.enabled).toBe(false);
  });
  it('keeps the same root request across resume but never grants it to a second profile/session', async () => {
    const f = await fixture();
    await f.control('start');
    const resumed = {
      ...f.authority,
      session: { ...f.authority.session, profile: 'saved-profile' },
    };
    expect(await f.adapter.needsResume(resumed)).toBe(true);
    const parallel = {
      ...resumed,
      session: { ...resumed.session, id: 'second-profile-session', threadId: 'second-root' },
    };
    expect(await f.adapter.needsResume(parallel)).toBe(false);
    await f.adapter.control(parallel, { capability: 'playwright', action: 'stop' }, true);
    expect(await f.adapter.needsResume(resumed)).toBe(true);
  });
  it('invalidates guidance on owned child exit and retries only after a new explicit request', async () => {
    const f = await fixture();
    await f.control('start');
    const state = await f.prepare();
    await f.adapter.verify(f.rpc, 'root-a', state);
    f.adapter.observe('session-other', {
      method: 'mcpServer/statusUpdated',
      params: { name: playwrightServerName, status: 'failed' },
    });
    f.adapter.observe('session-a', {
      method: 'mcpServer/statusUpdated',
      params: { name: playwrightServerName, threadId: 'other-root', status: 'failed' },
    });
    expect(state.turnInstructions).toContain('Verified');
    f.adapter.observe('session-a', {
      method: 'mcpServer/statusUpdated',
      params: { name: playwrightServerName, status: 'failed' },
    });
    expect(state.turnInstructions).toBe('');
    expect(await f.control('status')).toMatchObject({ status: 'unavailable' });
    expect(await f.adapter.needsResume(f.authority)).toBe(false);
    expect(await f.control('start')).toMatchObject({ status: 'pending' });
    const restarted = await f.prepare();
    expect(await f.adapter.verify(f.rpc, 'root-a', restarted)).toBe(true);
    expect(restarted.turnInstructions).toContain('Verified');
  });
  it('requires detachment/reverification after retained plan or milestone ownership changes', async () => {
    const f = await fixture();
    await f.control('start');
    const state = await f.prepare();
    await f.adapter.verify(f.rpc, 'root-a', state);
    const next = { ...f.authority, activePlanId: 'next-milestone', declared: false };
    expect(await f.adapter.needsResume(next)).toBe(true);
    expect(
      await f.adapter.control(next, { capability: 'playwright', action: 'status' }, true),
    ).toMatchObject({ status: 'pending' });
    expect(state.turnInstructions).toBe('');
    const stopped = await f.adapter.prepare(f.base, next, {
      rpc: f.rpc,
      skills: f.skills,
      deadline: Date.now() + 1000,
    });
    expect(stopped.config.mcp_servers).toMatchObject({
      [playwrightServerName]: { enabled: false },
    });
  });
  it('a failed base retrieval verifier cannot disable a verified browser', async () => {
    const f = await fixture();
    await f.control('start');
    const failed = {
      ...f.base,
      fallback() {
        this.ready = false;
        this.config = { mcp_servers: { 'gestalt-xerj': { enabled: false } } };
      },
    };
    const idle = { ...f.base, ready: false, capabilities: [] };
    const retrieval = new CodexCapabilities(
      { prepare: async () => failed, verify: async () => false } as unknown as CodexXerj,
      { prepare: async () => idle } as unknown as CodexSerena,
    );
    const base = await retrieval.prepare({
      cwd: f.root,
      deadline: Date.now() + 1000,
      rpc: f.rpc,
      skills: f.skills,
      skillsConfig: f.base.skillsConfig,
      config: {},
      start: false,
    });
    const state = await f.adapter.prepare(base, f.authority, {
      rpc: f.rpc,
      skills: f.skills,
      deadline: Date.now() + 1000,
    });
    expect(await retrieval.verify(f.rpc, 'root-a', base)).toBe(false);
    expect(await f.adapter.verify(f.rpc, 'root-a', state)).toBe(true);
    state.fallback();
    expect(state.config.mcp_servers).toMatchObject({
      'gestalt-xerj': { enabled: false },
      [playwrightServerName]: { enabled: true },
    });
    expect(state.turnInstructions).toContain('Verified');
  });
  it('bounds stalled MCP verification without dropping unrelated capability availability', async () => {
    const f = await fixture();
    await f.control('start');
    const rpc = {
      request: (method: string) =>
        method === 'config/read' ? Promise.resolve({ config: f.native }) : new Promise(() => {}),
    };
    const state = await f.adapter.prepare(f.base, f.authority, {
      rpc,
      skills: f.skills,
      deadline: Date.now() + 50,
    });
    expect(await f.adapter.verify(rpc, 'root-a', state)).toBe(false);
    expect(state.ready).toBe(true);
    expect(state.turnInstructions).toBe('');
  });
  it('binds an unavailable fresh declaration without resuming its unpersisted first root', async () => {
    const f = await fixture();
    f.authority.session = { ...f.authority.session, threadId: null };
    f.authority.declared = true;
    f.installation.ready.mockResolvedValue(missingChrome);
    const state = await f.prepare();
    f.adapter.bound(state, 'actual-fresh-root');
    const started = {
      ...f.authority,
      session: { ...f.authority.session, threadId: 'actual-fresh-root' },
    };
    expect(await f.adapter.needsResume(started)).toBe(false);
    expect(
      await f.adapter.control(started, { capability: 'playwright', action: 'status' }, true),
    ).toMatchObject({ status: 'unavailable' });
  });
});

describe('read-only managed Playwright installation', () => {
  it('validates versioned release metadata and performs no installation', async () => {
    const f = await fixture();
    const home = join(f.root, 'home');
    const release = join(home, 'playwright', 'release-0.0.83-test');
    await mkdir(release, { recursive: true });
    const manager = join(f.root, 'manager');
    await writeFile(manager, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const path = join(home, 'playwright', 'active.json');
    const metadata = JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      version: '0.0.83',
      release,
    });
    await writeFile(path, metadata);
    const adapter = new ManagedPlaywright({ GESTALT_HOME: home, GESTALT_MANAGER_BIN: manager });
    expect(await adapter.check()).toEqual({ status: 'installed', manager, version: '0.0.83' });
    expect(await readFile(path, 'utf8')).toBe(metadata);
    await writeFile(path, JSON.stringify({ schemaVersion: 9 }));
    expect(await adapter.check()).toEqual({ status: 'unavailable' });
  });
  it('reports missing metadata without starting any downloader', async () => {
    const f = await fixture();
    expect(await new ManagedPlaywright({ GESTALT_HOME: f.root }).check()).toEqual({
      status: 'absent',
    });
  });
  it.each([
    'valid',
    'oversized',
    'malformed',
    'timeout',
    'nonzero',
    'chrome-missing',
    'old-contract',
    'redacted-version',
  ])('bounds doctor output, exit and environment: %s', async (mode) => {
    const f = await fixture();
    const manager = join(f.root, 'doctor.cjs');
    const capture = join(f.root, 'capture.json');
    const ready = {
      schemaVersion: mode === 'old-contract' ? 2 : 1,
      contractVersion: 1,
      ready: mode !== 'chrome-missing',
      package: { ready: true },
      chrome: {
        ready: mode !== 'chrome-missing',
        version: mode === 'redacted-version' ? '/private/cookies.secret' : '151.0.7872.0',
        executable: '/private/chrome-path',
      },
      node: { ready: true },
    };
    const code =
      mode === 'timeout'
        ? 'setInterval(()=>{},1000)'
        : mode === 'oversized'
          ? 'process.stdout.write("x".repeat(40000))'
          : mode === 'malformed'
            ? 'process.stdout.write("invalid")'
            : `console.log(${JSON.stringify(JSON.stringify(ready))});${mode === 'nonzero' ? 'process.exitCode=1;' : ''}`;
    await writeFile(
      manager,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env)}));\n${code}\n`,
      { mode: 0o700 },
    );
    const adapter = new ManagedPlaywright({
      ...process.env,
      TEST_SECRET: 'must-not-be-forwarded',
    });
    const result = await adapter.ready(
      manager,
      f.root,
      Date.now() + (mode === 'timeout' ? 200 : 1000),
    );
    expect(result.ready).toBe(['valid', 'redacted-version'].includes(mode));
    if (['timeout', 'malformed', 'oversized', 'old-contract'].includes(mode))
      expect(result).toMatchObject({
        package: 'unknown',
        chrome: 'unknown',
        node: 'unknown',
        chromeVersion: null,
      });
    if (mode === 'chrome-missing')
      expect(result).toMatchObject({
        ready: false,
        package: 'ready',
        chrome: 'unavailable',
        node: 'ready',
      });
    if (mode === 'redacted-version') expect(result.chromeVersion).toBeNull();
    expect(JSON.stringify(result)).not.toContain('/private/');
    const evidence = JSON.parse(await readFile(capture, 'utf8'));
    expect(evidence.args).toEqual(['playwright', 'doctor', '--json', '--cwd', f.root]);
    expect(evidence.keys).not.toContain('TEST_SECRET');
    expect(
      evidence.keys.every((key: string) =>
        ['PATH', 'HOME', 'TMPDIR', 'GESTALT_HOME'].includes(key),
      ),
    ).toBe(true);
  });
});
