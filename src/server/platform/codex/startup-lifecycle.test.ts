/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { CodexSessionRuntime, type AppServer } from './session-runtime.js';
import { CodexJsonRpcError } from './json-rpc-client.js';
import { CodexCapabilities } from './codex-capabilities.js';
import { CodexSerena } from './codex-serena.js';
import { CodexPlaywright } from './codex-playwright.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { SessionModelConfig } from './session-model-config.js';
import { installStartupFixture, syntheticBlock } from './startup-guidance.fixture.js';

async function fixture(resumeError?: Error) {
  const root = await mkdtemp(join(tmpdir(), 'mobile lifecycle '));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const skills = await installStartupFixture(join(root, 'installed'));
  const pair = new CodexCapabilities(
    new CodexSerena({ check: async () => ({ status: 'absent' }) }),
  );
  const requests: Array<{ method: string; params: unknown }> = [];
  const browser = new CodexPlaywright({ check: vi.fn(), ready: vi.fn() });
  let starts = 0,
    permitted = true;
  const rpc: AppServer['rpc'] = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'config/read')
        return { config: { developer_instructions: 'USER_ROLE_GUIDANCE' } };
      if (method === 'thread/start') return { thread: { id: `fresh-${++starts}` } };
      if (method === 'thread/resume' && resumeError) throw resumeError;
      if (method === 'turn/start') return { turn: { id: 'child-turn' } };
      return {};
    },
    onNotification: () => () => {},
    onServerRequest: () => () => {},
  };
  const prepare = vi.fn(async (session, rpc, config, deadline) =>
    browser.prepare(
      await pair.prepare({
        cwd: root,
        rpc,
        config,
        deadline,
        skills,
        skillsConfig: skills.map(({ path, enabled }) => ({ path, enabled })),
        start: true,
        startup: !session.threadId,
      }),
      { session, planIdentity: null, activePlanId: null, declared: false, fenced: false },
      { rpc, skills, deadline },
    ),
  );
  const launch = vi.fn(() => ({ rpc, close() {} }));
  const runtime = new CodexSessionRuntime(
    launch,
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
    async () => ({ model_reasoning_effort: 'medium' }),
    { prepare, verify: (rpc, thread, state) => pair.verify(rpc, thread, browser.base(state)) },
    () => {
      if (!permitted) throw new Error('FIXTURE_MANUAL_OFF_OR_ATTENTION');
    },
  );
  onTestFinished(() => runtime.stopAll());
  const session = RelaySession.create({
    id: 'fixture',
    provider: 'codex',
    workspaceId: 'w',
    workspacePath: root,
    profile: 'default',
    model: 'fixture',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    effectiveSkillSelection: { skills },
    now: 't',
  }).snapshot;
  return {
    root,
    session,
    runtime,
    requests,
    prepare,
    launch,
    setPermitted(value: boolean) {
      permitted = value;
    },
  };
}

it('prepares dynamic capabilities on repeated restore without starting another root or adding a stable layer', async () => {
  const f = await fixture();
  let session = await f.runtime.start(f.session, 't');
  const original = session.threadId;
  for (let index = 0; index < 2; index++) {
    await f.runtime.release(session.id);
    session = await f.runtime.restore(RelaySession.rehydrate(session).stop('u').snapshot, 'v');
    expect(session.threadId).toBe(original);
  }
  expect(f.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
  const resumed = f.requests.filter((request) => request.method === 'thread/resume');
  expect(resumed).toHaveLength(2);
  for (const request of resumed) {
    expect(request.params).not.toHaveProperty('developerInstructions');
    expect(request.params).not.toHaveProperty('baseInstructions');
    expect(JSON.stringify(request.params)).not.toContain('<!-- gestalt:startup:v1 -->');
  }
  expect(f.prepare).toHaveBeenCalledTimes(3);
});

it('assembles the selected bootstrap for an authorized missing-rollout replacement before publishing its identity', async () => {
  const f = await fixture(new CodexJsonRpcError(-32600, 'no rollout found for thread id absent'));
  const stopped = RelaySession.rehydrate(f.session).bindThread('absent', 't').stop('u').snapshot;
  const result = await f.runtime.restoreWithOutcome(stopped, 'v');
  expect(result).toMatchObject({
    historyUnavailable: true,
    replacementCreated: true,
    session: { threadId: 'fresh-1' },
  });
  const sent = f.requests.find((request) => request.method === 'thread/start')!.params as {
    config: { developer_instructions?: string };
  };
  expect(sent.config.developer_instructions?.includes(syntheticBlock)).toBe(true);
  expect(sent.config.developer_instructions?.split(syntheticBlock)).toHaveLength(2);
  expect(sent.config.developer_instructions?.includes('USER_ROLE_GUIDANCE')).toBe(true);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.requests.filter((request) => request.method === 'config/read')).toHaveLength(2);
  expect(sent).toMatchObject({
    approvalPolicy: 'never',
    sandbox: 'read-only',
    model: 'fixture',
    config: { model_reasoning_effort: 'medium' },
  });
  for (const name of ['serena', 'playwright'])
    expect(sent.config.developer_instructions?.split(`<gestalt_${name}_unavailable>`)).toHaveLength(
      2,
    );
  expect(sent).not.toHaveProperty('developerInstructions');
  expect(sent).not.toHaveProperty('baseInstructions');
});

it.each([
  new CodexJsonRpcError(-32600, 'invalid configuration'),
  new Error('transport unavailable'),
])('never replaces a retained thread for an unrelated resume failure: %s', async (error) => {
  const f = await fixture(error);
  const stopped = RelaySession.rehydrate(f.session).bindThread('retained', 't').stop('u').snapshot;
  await expect(f.runtime.restoreWithOutcome(stopped, 'v')).rejects.toBe(error);
  expect(f.requests.some((request) => request.method === 'thread/start')).toBe(false);
  expect(stopped.threadId).toBe('retained');
});

it('child continuation retains its admission fence and never copies root config or reassembles startup guidance', async () => {
  const f = await fixture();
  const started = await f.runtime.start(f.session, 't');
  f.setPermitted(false);
  const before = f.requests.length;
  await expect(
    f.runtime.startExecutorTurn(started, 'child', 'CHILD_CONTINUATION', 'denied'),
  ).rejects.toThrow('FIXTURE_MANUAL_OFF_OR_ATTENTION');
  expect(f.requests).toHaveLength(before);
  f.setPermitted(true);
  await f.runtime.startExecutorTurn(started, 'child', 'CHILD_CONTINUATION', 'permitted');
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.requests.at(-1)).toEqual({
    method: 'turn/start',
    params: {
      threadId: 'child',
      input: [{ type: 'text', text: 'CHILD_CONTINUATION', text_elements: [] }],
      clientUserMessageId: 'permitted',
    },
  });
});

it('executor model derivation preserves complete role-owned startup and native role bytes across sessions', async () => {
  const f = await fixture();
  const home = join(f.root, 'home');
  await mkdir(join(home, 'agents'), { recursive: true });
  const path = join(home, 'agents/org-plan-executor.toml');
  const role = `name='org-plan-executor'\nmodel='old-fixture'\nmodel_reasoning_effort='high'\ndeveloper_instructions=${JSON.stringify('ROLE_ONLY_DUTIES\n' + syntheticBlock)}\n`;
  await writeFile(path, role);
  const resolver = new SessionModelConfig(home, join(f.root, 'state'));
  for (const id of ['first', 'second']) {
    const config = await resolver.resolve({
      ...f.session,
      id,
      modelSettings: { executorModel: 'fixture', executorReasoningEffort: 'medium' },
    });
    const derived = (config.agents as Record<string, { config_file: string }>)['org-plan-executor']
      .config_file;
    const expected = role
      .replace("model='old-fixture'", 'model = "fixture"')
      .replace("model_reasoning_effort='high'", 'model_reasoning_effort = "medium"');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(hash(await readFile(derived, 'utf8'))).toBe(hash(expected));
  }
  expect(await readFile(path, 'utf8')).toBe(role);
});
