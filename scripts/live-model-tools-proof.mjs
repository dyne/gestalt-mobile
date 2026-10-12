/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Deterministic provider, actual native model-tool/child paths. No genuine-provider claim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createConnection, createServer as socketServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { CodexSessionRuntime } from '../dist/server/server/platform/codex/session-runtime.js';
import { launchCodexAppServer } from '../dist/server/server/platform/codex/codex-process-launcher.js';
import { RelaySession } from '../dist/server/server/features/sessions/model/relay-session.js';
import { LIVE_CODEX_SHA256 } from '../dist/server/server/platform/live-design/installed-policy.js';
import {
  LIVE_CODEX_SOURCE,
  LIVE_CODEX_BWRAP_SHA256,
} from '../dist/server/server/platform/live-design/native-contract.js';

assert.equal(process.env.LIVE_NATIVE_MODEL_PROOF, '1', 'Disposable supported-host opt-in required');
const binary = realpathSync(process.env.LIVE_HOST_CODEX_BINARY);
const evidence = resolve(process.env.LIVE_MODEL_EVIDENCE ?? 'test-results/live-model-tools');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(readFileSync(binary)), LIVE_CODEX_SHA256);
const bwrap = [
  join(dirname(binary), 'codex-resources/bwrap'),
  join(dirname(dirname(binary)), 'codex-resources/bwrap'),
  join(dirname(binary), 'bwrap'),
].find((path) => existsSync(path));
assert.ok(bwrap, 'Bundled native sandbox resource unavailable');
assert.equal(digest(readFileSync(bwrap)), LIVE_CODEX_BWRAP_SHA256);
const daemon = `/tmp/codex-daemon-${process.getuid()}`;
if (existsSync(daemon))
  assert.equal(lstatSync(daemon).mode & 0o777, 0o700, 'Trusted host launch unavailable');
const root = mkdtempSync(join(dirname(binary), 'l11 native model proof '));
const app = join(root, 'app');
const controller = join(root, 'controller');
const nativeHome = join(controller, 'native-home');
for (const path of [app, controller, nativeHome, evidence])
  mkdirSync(path, { mode: 0o700, recursive: true });
const privateFile = join(controller, 'auth-canary');
const privateCanary = randomBytes(32).toString('hex');
writeFileSync(privateFile, privateCanary, { mode: 0o600 });
const privateFd = openSync(privateFile, 'r');
writeFileSync(join(app, 'public.txt'), 'public-native-work', { mode: 0o600 });
const socket = join(controller, 'admin.sock');
let socketConnections = 0;
const admin = socketServer((peer) => {
  socketConnections++;
  peer.end();
});
const rootMarker = 'L11_NATIVE_ROOT_CONFINEMENT';
const childMarker = 'L11_NATIVE_CHILD_CONFINEMENT';
const roles = new Map();
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const report = {
  schemaVersion: 1,
  passed: false,
  stage: 'initialization',
  checks: {},
  provenance: {
    binarySha256: LIVE_CODEX_SHA256,
    nativeSource: LIVE_CODEX_SOURCE,
    bundledBwrapSha256: LIVE_CODEX_BWRAP_SHA256,
    mobileTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    sourceFiles: Object.fromEntries(
      [
        'scripts/live-model-tools-proof.mjs',
        'src/server/platform/codex/codex-process-launcher.ts',
        'src/server/platform/codex/session-runtime.ts',
        'src/server/platform/live-design/installed-policy.ts',
        'src/server/platform/live-design/native-contract.ts',
      ].map((path) => [path, digest(readFileSync(path))]),
    ),
  },
  provider: { kind: 'deterministic-local-responses', genuine: false, requestCount: 0 },
  limitations: [
    'Not genuine credential-dependent provider evidence.',
    'Does not admit network-capable helper/devserver processes or prove picker integration.',
  ],
};
let appServer,
  runtime,
  session,
  rootCompleted = false,
  childCompleted = false,
  providerFailure = false;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(condition, budget = 60000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(25);
  }
  throw new Error('NATIVE_PROOF_DEADLINE');
}
function availableTools(tools, namespace) {
  return (tools ?? []).flatMap((tool) =>
    tool.type === 'namespace' ? availableTools(tool.tools, tool.name) : [{ ...tool, namespace }],
  );
}
function functionCall(tool, callId, args) {
  const item = {
    type: 'function_call',
    call_id: callId,
    name: tool.name,
    arguments: JSON.stringify(args),
  };
  if (tool.namespace) item.namespace = tool.namespace;
  return { type: 'response.output_item.done', item };
}
function patchCall(tool, callId, patch) {
  const item = { type: 'custom_tool_call', call_id: callId, name: tool.name, input: patch };
  if (tool.namespace) item.namespace = tool.namespace;
  return { type: 'response.output_item.done', item };
}
function finalMessage(id) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      role: 'assistant',
      id,
      content: [{ type: 'output_text', text: 'Controlled native proof complete.' }],
    },
  };
}
function userText(input) {
  return (
    (input ?? [])
      .filter((item) => item.role === 'user')
      .flatMap((item) =>
        (item.content ?? [])
          .filter((content) => content.type === 'input_text')
          .map((content) => content.text),
      )
      .at(-1) ?? ''
  );
}
function nextEvent(body) {
  const role = userText(body.input).includes(childMarker) ? 'child' : 'root';
  const step = roles.get(role) ?? 0;
  roles.set(role, step + 1);
  const tools = availableTools(body.tools);
  const find = (name) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `Missing required native tool: ${name}`);
    return tool;
  };
  assert.equal(body.model, 'gpt-6-sol');
  assert.equal(body.reasoning?.effort, 'medium');
  const id = `${role}-${step}`;
  if (step === 1) {
    const output = body.input?.find(
      (item) => item.type === 'function_call_output' && item.call_id === `${role}-0`,
    );
    assert.ok(
      output &&
        ['public-native-work', 'native-socket-denied', 'native-daemon-denied'].every((marker) =>
          JSON.stringify(output.output).includes(marker),
        ),
      'Native command did not prove permitted public read',
    );
  }
  if (step === 0) {
    const probe =
      'import socket,sys\np=socket.socket(socket.AF_UNIX)\ntry:\n p.connect(sys.argv[1]); print("native-socket-breach")\nexcept OSError as e:\n if e.errno in [1,2,13,20]: print("native-socket-denied")\n else: raise\n';
    const command = `cat ${shellQuote(join(app, 'public.txt'))}; cat ${shellQuote(privateFile)}; cat ${shellQuote(`/proc/${process.pid}/root${privateFile}`)}; cat ${shellQuote(`/proc/${process.pid}/fd/${privateFd}`)}; /usr/bin/python3 -c ${shellQuote(probe)} ${shellQuote(socket)}; if ls ${shellQuote(daemon)} >/dev/null 2>&1; then echo native-daemon-breach; else echo native-daemon-denied; fi`;
    return functionCall(find('exec_command'), id, {
      cmd: command,
      max_output_tokens: 1024,
      yield_time_ms: 1000,
    });
  }
  if (step === 1)
    return patchCall(
      find('apply_patch'),
      id,
      `*** Begin Patch\n*** Add File: ${join(app, `${role}-native-edit.txt`)}\n+permitted-native-edit\n*** End Patch`,
    );
  if (step === 2)
    return patchCall(
      find('apply_patch'),
      id,
      `*** Begin Patch\n*** Add File: ${join(controller, `${role}-forbidden-edit.txt`)}\n+forbidden-native-edit\n*** End Patch`,
    );
  if (role === 'root' && step === 3) {
    const spawn = find('spawn_agent');
    const properties = spawn.parameters?.properties ?? {};
    assert.ok(properties.fork_turns || properties.fork_context);
    return functionCall(spawn, id, {
      message: childMarker,
      agent_type: 'default',
      ...(properties.task_name ? { task_name: 'confinement_probe' } : {}),
      ...(properties.fork_turns ? { fork_turns: 'none' } : { fork_context: false }),
    });
  }
  if (role === 'child') childCompleted = true;
  return finalMessage(id);
}
const provider = createServer(async (request, response) => {
  try {
    if (providerFailure) {
      response.writeHead(503);
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ data: [{ id: 'gpt-6-sol', object: 'model', owned_by: 'controlled' }] }),
      );
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      assert.ok(length < 4 * 1024 * 1024);
      chunks.push(chunk);
    }
    const compressed = Buffer.concat(chunks);
    const compression = request.headers['content-encoding'];
    const decoder = { gzip: gunzipSync, deflate: inflateSync, zstd: zstdDecompressSync }[
      compression
    ];
    assert.ok(
      !compression || compression === 'identity' || decoder,
      'Unsupported request encoding',
    );
    const bytes = decoder ? decoder(compressed, { maxOutputLength: 4 * 1024 * 1024 }) : compressed;
    assert.ok(
      !bytes.includes(Buffer.from(privateCanary)),
      'Native private read leaked to model provider',
    );
    const body = JSON.parse(bytes);
    report.provider.requestCount++;
    assert.ok(report.provider.requestCount <= 20);
    const id = `controlled-${report.provider.requestCount}`;
    const event = nextEvent(body);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const data of [
      { type: 'response.created', response: { id } },
      event,
      {
        type: 'response.completed',
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      },
    ])
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    response.end();
  } catch {
    providerFailure = true;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
try {
  await new Promise((done, reject) => {
    admin.once('error', reject);
    admin.listen(socket, done);
  });
  await new Promise((done, reject) => {
    const peer = createConnection(socket);
    peer.once('error', reject);
    peer.once('end', done);
    peer.resume();
  });
  assert.equal(socketConnections, 1);
  await new Promise((done, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', done);
  });
  const providerPort = provider.address().port;
  const config = `model = "gpt-6-sol"\nmodel_provider = "controlled"\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\ndefault_permissions = "workspace-git"\nmcp_servers = {}\nplugins = {}\n[model_providers.controlled]\nname = "Controlled native proof"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\ndaemon_auto_start = false\ncode_mode = false\nmulti_agent = true\nmulti_agent_v2 = true\nhooks = false\n[permissions.workspace-git]\nextends = ":workspace"\n[permissions.workspace-git.filesystem]\n":root" = "read"\n${JSON.stringify(app)} = "write"\n${JSON.stringify(controller)} = "deny"\n"/proc" = "deny"\n[permissions.workspace-git.network]\nenabled = false\n`;
  writeFileSync(join(nativeHome, 'config.toml'), config, { mode: 0o600 });
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: nativeHome,
    CODEX_HOME: nativeHome,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
  };
  let launches = 0;
  runtime = new CodexSessionRuntime(
    (input) => {
      launches++;
      assert.equal(launches, 1);
      appServer = launchCodexAppServer(input, {
        executable: binary,
        sha256: LIVE_CODEX_SHA256,
        environment: env,
      });
      appServer.child.stderr.resume();
      return appServer;
    },
    undefined,
    (_sessionId, notification) => {
      if (
        notification.method === 'turn/completed' &&
        notification.params?.threadId === session?.threadId
      ) {
        if (notification.params?.turn?.status === 'completed') rootCompleted = true;
        else providerFailure = true;
      }
    },
  );
  report.stage = 'owning-runtime';
  session = await runtime.start(
    RelaySession.create({
      id: 'l11-native-proof',
      workspaceId: 'fixture',
      workspacePath: app,
      profile: 'default',
      provider: 'codex',
      model: 'gpt-6-sol',
      modelSettings: { reasoningEffort: 'medium' },
      effectiveSkillSelection: { skills: [] },
      approvalPolicy: 'never',
      sandbox: 'workspace-git',
      now: new Date().toISOString(),
    }).snapshot,
    new Date().toISOString(),
  );
  const admitted = await runtime.inspectLiveAdmission(session);
  assert.equal(admitted.launch.executableDigest, LIVE_CODEX_SHA256);
  assert.equal(admitted.launch.cwd, app);
  assert.equal(admitted.thread.thread.id, session.threadId);
  assert.equal(admitted.threadSelection?.activePermissionProfile?.id, 'workspace-git');
  assert.equal(admitted.threadSelection?.model, session.model);
  assert.equal(admitted.threadSelection?.cwd, app);
  assert.ok(admitted.configuration.layers.length);
  report.checks.existingRuntimeInspected = true;
  report.stage = 'actual-model-tools-and-child';
  session = await runtime.startTurn(
    session,
    rootMarker,
    'fixture-native-turn',
    new Date().toISOString(),
  );
  await until(() => providerFailure || (rootCompleted && childCompleted));
  assert.equal(providerFailure, false);
  await until(() => existsSync(join(app, 'child-native-edit.txt')));
  for (const role of ['root', 'child']) {
    assert.equal(
      readFileSync(join(app, `${role}-native-edit.txt`), 'utf8'),
      'permitted-native-edit\n',
    );
    assert.equal(existsSync(join(controller, `${role}-forbidden-edit.txt`)), false);
  }
  assert.equal(readFileSync(privateFile, 'utf8'), privateCanary);
  assert.equal(socketConnections, 1);
  const children = await runtime.listDirectChildren(session);
  assert.equal(children.length, 1);
  const child = await appServer.rpc.request('thread/read', {
    threadId: children[0].id,
    includeTurns: false,
  });
  assert.equal(child.thread.parentThreadId, session.threadId);
  assert.equal(child.thread.sessionId, admitted.thread.thread.sessionId);
  assert.equal(child.thread.model, session.model);
  assert.equal(child.thread.reasoningEffort, 'medium');
  assert.equal(roles.get('child'), 4);
  await until(async () => {
    const current = await appServer.rpc.request('thread/read', {
      threadId: children[0].id,
      includeTurns: false,
    });
    return current.thread.status?.type === 'idle';
  });
  const after = await runtime.inspectLiveAdmission(session);
  assert.deepEqual(after.launch, admitted.launch);
  assert.equal(after.thread.thread.id, admitted.thread.thread.id);
  assert.equal(after.threadSelection?.activePermissionProfile?.id, 'workspace-git');
  report.checks.modelFileEditPermitted = true;
  report.checks.modelPrivateEditDenied = true;
  report.checks.modelPrivateReadNeverReachedProvider = true;
  report.checks.actualModelAndChildSocketAndDaemonDenials = true;
  report.checks.permittedNativeChildInheritedConfinement = true;
  report.checks.sameOwningThreadModelThinkingAndProcess = true;
  report.stage = 'shutdown';
  const childProcess = appServer.child;
  runtime.stopAll();
  await until(() => childProcess.exitCode !== null || childProcess.signalCode !== null, 10000);
  report.checks.ownedRuntimeExited = true;
  report.passed = true;
  report.stage = 'complete';
} catch {
  process.exitCode = 1;
} finally {
  runtime?.stopAll();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  await new Promise((done) => admin.close(done));
  closeSync(privateFd);
  writeFileSync(
    join(evidence, 'native-model-tools-proof.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  // Only fixed outcomes enter logs. Prompts, model/tool responses and secrets never do.
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      stage: report.stage,
      provider: 'deterministic',
      genuine: false,
    }) + '\n',
  );
  if (!appServer || appServer.child.exitCode !== null || appServer.child.signalCode !== null)
    rmSync(root, { recursive: true, force: true });
}
