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
import { launchCodexAppServer, type CodexProcess } from './codex-process-launcher.js';
import { CodexCapabilities } from './codex-capabilities.js';
import { CodexSerena } from './codex-serena.js';
import { CodexXerj } from '../retrieval/codex-xerj.js';
import { CodexSessionRuntime } from './session-runtime.js';
import { SessionModelConfig } from './session-model-config.js';
import {
  RelaySession,
  type RelaySessionSnapshot,
} from '../../features/sessions/model/relay-session.js';
import type { AvailableSkill } from '../../features/skills/model/skill-profile.js';
import { sessionScratchEnvironmentKeys } from '../scratch/child-environment.js';
import {
  installStartupFixture,
  startupDescriptor,
  syntheticBlock,
} from './startup-guidance.fixture.js';

type Item = {
  type?: string;
  role?: string;
  content?: string | Array<{ text?: string }>;
  output?: string;
};
type ModelInput = {
  instructions?: string;
  input: Item[];
  tools: Array<{ name?: string; type?: string; tools?: Array<{ name: string }> }>;
};
type Capture = { phase: string; child: boolean; input: ModelInput };
const count = (text: string, value: string) => text.split(value).length - 1;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const roleParts = (input: ModelInput) =>
  input.input
    .filter((item) => ['developer', 'system'].includes(item.role ?? ''))
    .flatMap((item) =>
      (typeof item.content === 'string'
        ? [item.content]
        : (item.content?.map((part) => part.text) ?? [])
      )
        .filter((text): text is string => typeof text === 'string')
        .map((text) => ({ role: item.role, text })),
    );
const instructions = (input: ModelInput) =>
  roleParts(input)
    .map((part) => part.text)
    .join('\n');
// Synthetic captures stay in memory. Export only fixed markers, sizes and hashes,
// including the separate foundation channel rather than assuming an input layout.
const diagnosticMarkers = [
  '<!-- gestalt:startup:v1 -->',
  'ROOT_ONLY_DUTIES',
  'ROLE_ONLY_DUTIES',
  'LIFECYCLE_REPOSITORY_GUIDANCE',
  '<skills_instructions>',
  '<permissions instructions>',
  '<environment_context>',
  '<gestalt_xerj_capability>',
  '<gestalt_serena_capability>',
] as const;
const describeText = (text: string) => ({
  bytes: Buffer.byteLength(text),
  sha256: digest(text),
  markers: diagnosticMarkers.map((marker) => count(text, marker)),
  completeBootstrap: count(text, syntheticBlock),
});
function diagnoseComponents(label: string, baseline: ModelInput, captures: Capture[]) {
  const parts = (input: ModelInput) => [
    { role: 'request.instructions', text: input.instructions ?? '' },
    ...roleParts(input),
  ];
  const original = parts(baseline);
  console.info(
    'lifecycle-native-structure',
    JSON.stringify({
      label,
      markerOrder: diagnosticMarkers,
      baseline: original.map(({ role, text }) => ({ role, ...describeText(text) })),
      captures: captures.map((capture) => ({
        phase: capture.phase,
        child: capture.child,
        components: parts(capture.input).map(({ role, text }) => ({
          role,
          ...describeText(text),
        })),
        baselineMatches: original.map((component) =>
          parts(capture.input).map((part) => {
            let prefix = 0,
              suffix = 0;
            while (
              prefix < Math.min(component.text.length, part.text.length) &&
              component.text[prefix] === part.text[prefix]
            )
              prefix++;
            while (
              suffix < Math.min(component.text.length, part.text.length) - prefix &&
              component.text.at(-suffix - 1) === part.text.at(-suffix - 1)
            )
              suffix++;
            return {
              sameRole: component.role === part.role,
              occurrences: component.text ? count(part.text, component.text) : null,
              prefixChars: prefix,
              suffixChars: suffix,
              removed: describeText(component.text.slice(prefix, component.text.length - suffix)),
              added: describeText(part.text.slice(prefix, part.text.length - suffix)),
            };
          }),
        ),
      })),
    }),
  );
}
const userText = (input: ModelInput) =>
  input.input
    .filter((item) => item.role === 'user')
    .map((item) => JSON.stringify(item.content))
    .join('\n');
const run = promisify(execFile);

async function fixture(options: { legacy?: boolean; role?: 'default' | 'named' | 'owned' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mobile native lifecycle '));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    marketplace = join(root, 'marketplace');
  await Promise.all(
    [home, workspace, join(marketplace, '.agents/plugins'), join(home, 'agents')].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const plugin = join(marketplace, 'plugins/gestalt');
  await installStartupFixture(plugin);
  await writeFile(
    join(marketplace, '.agents/plugins/marketplace.json'),
    JSON.stringify({
      name: 'mobile-lifecycle-fixture',
      plugins: [{ name: 'gestalt', source: { source: 'local', path: './plugins/gestalt' } }],
    }),
  );
  const captures: Capture[] = [],
    errors: string[] = [];
  let phase = 'initial',
    spawned = false,
    waited = false;
  const model = createServer(async (request, response) => {
    let body = '';
    for await (const data of request) body += String(data);
    const input = JSON.parse(body) as ModelInput;
    const users = userText(input);
    const child = users.includes('LIFECYCLE_CHILD') && !users.includes('LIFECYCLE_ROOT');
    captures.push({ phase, child, input });
    const tools: Array<{ name: string; namespace?: string }> = (input.tools ?? []).flatMap(
      (tool): Array<{ name: string; namespace?: string }> =>
        tool.type === 'namespace'
          ? (tool.tools ?? [])
              .filter((nested) => typeof nested.name === 'string')
              .map((nested) => ({ name: nested.name, namespace: tool.name }))
          : typeof tool.name === 'string'
            ? [{ name: tool.name }]
            : [],
    );
    const call = (name: string, args: unknown) => {
      const tool = tools.find((tool) => tool.name === name);
      if (!tool) {
        errors.push('missing-native-' + name);
        return undefined;
      }
      return {
        id: 'call_' + name,
        type: 'function_call',
        status: 'completed',
        name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        call_id: name,
        arguments: JSON.stringify(args),
      };
    };
    let item: unknown;
    if (options.role && !child && !spawned) {
      spawned = true;
      item = call('spawn_agent', {
        message: 'LIFECYCLE_CHILD',
        fork_context: false,
        ...(options.role === 'default' ? {} : { agent_type: 'org-plan-executor' }),
      });
    } else if (options.role && !child && !waited) {
      waited = true;
      const childId = input.input
        .filter((item) => item.type === 'function_call_output')
        .map((item) => {
          try {
            return JSON.parse(item.output ?? '{}').agent_id as string | undefined;
          } catch {
            return undefined;
          }
        })
        .find(Boolean);
      if (childId) item = call('wait_agent', { targets: [childId], timeout_ms: 10_000 });
      else errors.push('missing-native-child-identity');
    }
    item ??= {
      id: 'msg_' + captures.length,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Synthetic lifecycle complete.', annotations: [] }],
    };
    const result = {
      id: 'resp_' + captures.length,
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
  const processes: CodexProcess[] = [];
  const runtimeHolder: { current?: CodexSessionRuntime } = {};
  onTestFinished(async () => {
    await runtimeHolder.current?.release('fixture');
    for (const process of processes) await process.closeAndWait();
    model.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      model.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const rolePath = join(home, 'agents/org-plan-executor.toml');
  const roleBytes = `name='org-plan-executor'\nmodel='old-fixture'\nmodel_reasoning_effort='high'\ndeveloper_instructions=${JSON.stringify('ROLE_ONLY_DUTIES\n' + (options.role === 'owned' ? syntheticBlock : ''))}\n`;
  await writeFile(rolePath, roleBytes);
  const config = `model='fixture'\nmodel_provider='fixture'\napproval_policy='never'\ndeveloper_instructions='ROOT_ONLY_DUTIES'\n[model_providers.fixture]\nname='fixture'\nbase_url='http://127.0.0.1:${port}/v1'\nwire_api='responses'\nrequires_openai_auth=false\n[features]\nhooks=true\nmulti_agent=true\ntool_search=false\n[skills]\n[[skills.config]]\nname='gestalt:xerj'\nenabled=false\n[[skills.config]]\nname='gestalt:serena'\nenabled=false\n[agents.org-plan-executor]\ndescription='Synthetic installed executor role'\nconfig_file=${JSON.stringify(rolePath)}\n`;
  await writeFile(join(home, 'config.toml'), config);
  const environment = { ...process.env, CODEX_HOME: home };
  for (const args of [
    ['plugin', 'marketplace', 'add', marketplace],
    ['plugin', 'add', 'gestalt@mobile-lifecycle-fixture'],
  ])
    await run('codex', args, { env: environment, cwd: workspace, timeout: 15_000 });
  const installed = join(home, 'plugins/cache/mobile-lifecycle-fixture/gestalt/0.0.1');
  const descriptorPath = join(installed, 'gestalt-startup-contract.json');
  if (options.legacy) await rm(descriptorPath);
  await writeFile(join(workspace, 'AGENTS.md'), 'LIFECYCLE_REPOSITORY_GUIDANCE');
  const originalConfig = await readFile(join(home, 'config.toml'), 'utf8');
  const sent: Array<{ method: string; params: unknown }> = [];
  const completed = new Set<string>();
  const pair = new CodexCapabilities(
    new CodexXerj({ check: async () => ({ status: 'absent' }) }),
    new CodexSerena({ check: async () => ({ status: 'absent' }) }),
  );
  const resolver = new SessionModelConfig(home, join(root, 'mobile-state'));
  const allowed = new Set<string>();
  const control = { manualOff: false, attention: false };
  let active: CodexProcess | undefined;
  const runtime = new CodexSessionRuntime(
    () => {
      const owningEnvironment: Record<string, string> = { CODEX_HOME: home };
      for (const key of sessionScratchEnvironmentKeys)
        if (process.env[key] !== undefined) owningEnvironment[key] = process.env[key]!;
      const codexProcess = launchCodexAppServer({
        profile: 'default',
        cwd: workspace,
        environment: owningEnvironment,
      });
      processes.push(codexProcess);
      active = codexProcess;
      codexProcess.rpc.onNotification((notification) => {
        if (notification.method === 'turn/completed')
          completed.add((notification.params as { turn: { id: string } }).turn.id);
      });
      const native = codexProcess.rpc;
      return {
        ...codexProcess,
        rpc: {
          request: async (method: string, params: unknown) => {
            sent.push({ method, params });
            return native.request(method, params);
          },
          onNotification: native.onNotification.bind(native),
          onServerRequest: native.onServerRequest.bind(native),
        },
      };
    },
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
    options.role && options.role !== 'default' ? (session) => resolver.resolve(session) : undefined,
    {
      prepare: async (session, rpc, config, deadline) => {
        const catalog = (await rpc.request('skills/list', {
          cwds: [workspace],
          forceReload: true,
        })) as { data: Array<{ cwd: string; skills: AvailableSkill[] }> };
        const skills = catalog.data
          .find((entry) => entry.cwd === workspace)!
          .skills.map(({ name, path, enabled }) => ({ name, path, enabled }));
        return pair.prepare({
          cwd: workspace,
          rpc,
          config,
          deadline,
          skills,
          skillsConfig: skills.map(({ path, enabled }) => ({ path, enabled })),
          start: true,
          startup: !session.threadId,
        });
      },
      verify: (rpc, thread, state) => pair.verify(rpc, thread, state),
    },
    (_session, thread) => {
      if (!allowed.has(thread) || control.manualOff || control.attention)
        throw new Error('FIXTURE_CHILD_CONTINUATION_FENCED');
    },
  );
  runtimeHolder.current = runtime;
  const initial = {
    ...RelaySession.create({
      id: 'fixture',
      provider: 'codex',
      workspaceId: 'w',
      workspacePath: workspace,
      profile: 'default',
      model: 'fixture',
      effectiveSkillSelection: { skills: [] },
      ...(options.role && options.role !== 'default'
        ? {
            modelSettings: { executorModel: 'fixture', executorReasoningEffort: 'medium' as const },
          }
        : {}),
      now: 't',
    }).snapshot,
    executionPolicy: { approvalPolicy: 'never' as const, sandbox: 'read-only' as const },
  };
  const wait = async (turn: string) =>
    vi.waitFor(() => expect(completed.has(turn)).toBe(true), { timeout: 20_000 });
  const turn = async (session: RelaySessionSnapshot, label: string) => {
    phase = label;
    const started = await runtime!.startTurn(session, 'LIFECYCLE_ROOT ' + label, undefined, 'u');
    await wait(started.activeTurnId!);
    return RelaySession.rehydrate(started).completeTurn(started.activeTurnId!, 'v').snapshot;
  };
  const childTurn = async (session: RelaySessionSnapshot, child: string, label: string) => {
    phase = label;
    const id = await runtime!.startExecutorTurn(session, child, 'LIFECYCLE_CHILD ' + label, label);
    await wait(id);
  };
  // A paired native fork/resume bypasses Mobile preparation and continuation.
  // Compare its complete delivered components, including native foundation,
  // rather than exempting an unmarked component from lifecycle assertions.
  const nativeControl = async (threadId: string): Promise<Capture[]> => {
    const previousPhase = phase;
    phase = 'native-control';
    const before = captures.length;
    const fork = (await active!.rpc.request('thread/fork', { threadId })) as {
      thread: { id: string };
    };
    expect(fork.thread.id).not.toBe(threadId);
    await active!.rpc.request('thread/resume', { threadId: fork.thread.id });
    const started = (await active!.rpc.request('turn/start', {
      threadId: fork.thread.id,
      input: [{ type: 'text', text: 'LIFECYCLE_CHILD native-control', text_elements: [] }],
    })) as { turn: { id: string } };
    await wait(started.turn.id);
    const controlCaptures = captures.splice(before);
    expect(controlCaptures.length).toBeGreaterThan(0);
    phase = previousPhase;
    return controlCaptures;
  };
  return {
    root,
    home,
    workspace,
    installed,
    descriptorPath,
    rolePath,
    roleBytes,
    originalConfig,
    captures,
    sent,
    errors,
    runtime,
    initial,
    allowed,
    control,
    turn,
    childTurn,
    nativeControl,
    rpc: () => active!.rpc,
    setPhase(value: string) {
      phase = value;
    },
  };
}

function assertSameComponents(label: string, baseline: ModelInput, captures: Capture[]) {
  expect(captures.length).toBeGreaterThan(0);
  for (const capture of captures) {
    const expected = roleParts(baseline),
      actual = roleParts(capture.input);
    const matches = expected.map((component) =>
      actual
        .filter((part) => part.role === component.role)
        .reduce((total, part) => total + count(part.text, component.text), 0),
    );
    if (
      digest(capture.input.instructions ?? '') !== digest(baseline.instructions ?? '') ||
      actual.length !== expected.length ||
      matches.some((matches) => matches !== 1)
    )
      diagnoseComponents(label, baseline, [capture]);
    expect(digest(capture.input.instructions ?? '')).toBe(digest(baseline.instructions ?? ''));
    expect(actual).toHaveLength(expected.length);
    for (const matchesCount of matches) expect(matchesCount).toBe(1);
  }
}

function assertNativeControl(baseline: ModelInput, control: ModelInput) {
  const isRetainedLayer = (text: string) =>
    [
      'ROOT_ONLY_DUTIES',
      'ROLE_ONLY_DUTIES',
      '<skills_instructions>',
      '<permissions instructions>',
    ].some((marker) => text.includes(marker));
  const original = roleParts(baseline),
    actual = roleParts(control);
  expect(actual).toHaveLength(original.length);
  for (const component of original.filter((part) => isRetainedLayer(part.text)))
    expect(
      actual.filter((part) => part.role === component.role && part.text === component.text),
    ).toHaveLength(1);
  const before = original.filter((part) => !isRetainedLayer(part.text)),
    after = actual.filter((part) => !isRetainedLayer(part.text));
  // The observed native layout has exactly one remaining foundation component.
  // Its complete replacement is measured by the native control, then matched
  // exactly against Mobile's fork/continuation below; no unknown bytes are stripped.
  expect(before).toHaveLength(1);
  expect(after).toHaveLength(1);
  expect(after[0].role).toBe(before[0].role);
  expect(after[0].text.length).toBeGreaterThan(0);
  expect(digest(control.instructions ?? '')).toBe(digest(baseline.instructions ?? ''));
  console.info(
    'lifecycle-native-foundation-control',
    JSON.stringify({
      before: describeText(before[0].text),
      after: describeText(after[0].text),
    }),
  );
}

function assertDelivery(captures: Capture[], expectedBlocks: number, role = 'ROOT_ONLY_DUTIES') {
  expect(captures.length).toBeGreaterThan(0);
  for (const capture of captures) {
    const text = instructions(capture.input);
    expect(count(text, '<!-- gestalt:startup:v1 -->')).toBe(expectedBlocks);
    if (expectedBlocks) expect(count(text, syntheticBlock)).toBe(1);
    expect(count(text, role)).toBe(1);
    expect(JSON.stringify(capture.input.input).includes('LIFECYCLE_REPOSITORY_GUIDANCE')).toBe(
      true,
    );
    expect(count(text, '<gestalt_xerj_capability>')).toBe(0);
    expect(count(text, '<gestalt_serena_capability>')).toBe(0);
  }
}

it.skipIf(process.env.RUN_INSTALLED_CODEX !== '1').each([false, true])(
  'native retained lifecycle keeps durable bytes across restore/recovery/fork and contract update; legacy=%s',
  async (legacy) => {
    const f = await fixture({ legacy });
    let session = await f.runtime.start(f.initial, 't');
    session = await f.turn(session, 'initial');
    const original = session.threadId;
    const baseline = f.captures[0].input;
    await f.runtime.release(session.id);
    // Update only selected package data inside this disposable installation.
    await writeFile(
      f.descriptorPath,
      JSON.stringify({ ...startupDescriptor, ...(!legacy ? { blockVersion: 2 } : {}) }),
    );
    for (const label of ['restored', 'repeated']) {
      session = await f.runtime.restore(RelaySession.rehydrate(session).stop('u').snapshot, 'v');
      session = await f.turn(session, label);
      expect(session.threadId).toBe(original);
      await f.runtime.release(session.id);
    }
    session = await f.runtime.restore(RelaySession.rehydrate(session).stop('u').snapshot, 'v');
    session = await f.runtime.recycle(session, 'v');
    session = await f.turn(session, 'recovered');
    expect(session.threadId).toBe(original);
    const control = await f.nativeControl(original!);
    assertNativeControl(baseline, control[0].input);
    const fork = (await f.rpc().request('thread/fork', { threadId: original })) as {
      thread: { id: string };
    };
    expect(fork.thread.id).not.toBe(original);
    f.allowed.add(fork.thread.id);
    await f.childTurn(session, fork.thread.id, 'forked');
    assertDelivery(f.captures, legacy ? 0 : 1);
    assertDelivery(control, legacy ? 0 : 1);
    assertSameComponents(
      'retained-root',
      baseline,
      f.captures.filter((c) => c.phase !== 'forked'),
    );
    assertSameComponents('native-fork-control', control[0].input, control);
    assertSameComponents(
      'mobile-fork',
      control[0].input,
      f.captures.filter((c) => c.phase === 'forked'),
    );
    expect(f.sent.filter((request) => request.method === 'thread/start')).toHaveLength(1);
    for (const request of f.sent.filter((request) => request.method === 'thread/resume')) {
      expect(request.params).not.toHaveProperty('developerInstructions');
      expect(request.params).not.toHaveProperty('baseInstructions');
    }
    expect(await readFile(join(f.home, 'config.toml'), 'utf8')).toBe(f.originalConfig);
  },
  90_000,
);

it.skipIf(process.env.RUN_INSTALLED_CODEX !== '1')(
  'native missing rollout creates a fresh replacement with one selected bootstrap',
  async () => {
    const f = await fixture();
    const stopped = RelaySession.rehydrate(f.initial)
      .bindThread('00000000-0000-4000-8000-000000000000', 't')
      .stop('u').snapshot;
    const result = await f.runtime.restoreWithOutcome(stopped, 'v');
    expect(result).toMatchObject({ replacementCreated: true, historyUnavailable: true });
    const session = await f.turn(result.session, 'replacement');
    expect(session.threadId).not.toBe(stopped.threadId);
    assertDelivery(f.captures, 1);
    expect(f.sent.filter((request) => request.method === 'thread/start')).toHaveLength(1);
  },
  60_000,
);

it.skipIf(process.env.RUN_INSTALLED_CODEX !== '1').each(['default', 'named', 'owned'] as const)(
  'native %s child startup and permitted continuation preserve role/durable startup without another root',
  async (role) => {
    const f = await fixture({ role });
    let session = await f.runtime.start(f.initial, 't');
    session = await f.turn(session, 'initial');
    expect(f.errors).toEqual([]);
    const roots = f.captures.filter((capture) => !capture.child),
      children = f.captures.filter((capture) => capture.child);
    assertDelivery(roots, 1);
    const blocks = role === 'named' ? 0 : 1;
    assertDelivery(children, blocks, role === 'default' ? 'ROOT_ONLY_DUTIES' : 'ROLE_ONLY_DUTIES');
    if (role !== 'default')
      for (const child of children)
        expect(count(instructions(child.input), 'ROOT_ONLY_DUTIES')).toBe(0);
    const childIds = roots
      .flatMap((capture) =>
        capture.input.input
          .filter((item) => item.type === 'function_call_output')
          .map((item) => {
            try {
              return JSON.parse(item.output ?? '{}').agent_id as string | undefined;
            } catch {
              return undefined;
            }
          }),
      )
      .filter((id): id is string => !!id);
    const childId = [...new Set(childIds)][0];
    expect(childId).toBeTruthy();
    const nativeControl = await f.nativeControl(childId);
    assertNativeControl(children[0].input, nativeControl[0].input);
    assertDelivery(
      nativeControl,
      blocks,
      role === 'default' ? 'ROOT_ONLY_DUTIES' : 'ROLE_ONLY_DUTIES',
    );
    f.allowed.add(childId);
    for (const fence of ['manualOff', 'attention'] as const) {
      f.control[fence] = true;
      const before = f.sent.length;
      await expect(
        f.runtime.startExecutorTurn(session, childId, 'LIFECYCLE_CHILD denied', 'denied'),
      ).rejects.toThrow('FIXTURE_CHILD_CONTINUATION_FENCED');
      expect(f.sent).toHaveLength(before);
      expect(f.control[fence]).toBe(true);
      f.control[fence] = false;
    }
    await f.runtime.release(session.id);
    session = await f.runtime.restore(RelaySession.rehydrate(session).stop('u').snapshot, 'v');
    await f.childTurn(session, childId, 'continued');
    assertDelivery(
      f.captures.filter((capture) => capture.child),
      blocks,
      role === 'default' ? 'ROOT_ONLY_DUTIES' : 'ROLE_ONLY_DUTIES',
    );
    const childBaseline = children[0].input;
    assertSameComponents(`child-${role}-initial`, childBaseline, children);
    assertSameComponents(`child-${role}-native-control`, nativeControl[0].input, nativeControl);
    assertSameComponents(
      `child-${role}-continued`,
      nativeControl[0].input,
      f.captures.filter((capture) => capture.child && capture.phase === 'continued'),
    );
    for (const child of f.captures.filter((capture) => capture.child)) {
      if (role !== 'default') expect(count(instructions(child.input), 'ROOT_ONLY_DUTIES')).toBe(0);
    }
    for (const request of f.sent.filter(
      (request) =>
        request.method === 'turn/start' &&
        (request.params as { threadId?: string }).threadId === childId,
    )) {
      expect(request.params).not.toHaveProperty('config');
      expect(request.params).not.toHaveProperty('developerInstructions');
      expect(request.params).not.toHaveProperty('baseInstructions');
    }
    expect(f.sent.filter((request) => request.method === 'thread/start')).toHaveLength(1);
    expect(await readFile(f.rolePath, 'utf8')).toBe(f.roleBytes);
  },
  90_000,
);
