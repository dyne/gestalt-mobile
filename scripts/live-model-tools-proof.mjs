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
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createConnection, createServer as socketServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { CodexSessionRuntime } from '../dist/server/server/platform/codex/session-runtime.js';
import { electLiveController } from '../dist/server/server/platform/live-design/elected-controller.js';
import { liveAppIdentity } from '../dist/server/server/platform/live-design/sqlite-live-ownership.js';
import { launchCodexAppServer } from '../dist/server/server/platform/codex/codex-process-launcher.js';
import { RelaySession } from '../dist/server/server/features/sessions/model/relay-session.js';
import {
  LIVE_CODEX_SHA256,
  InstalledLivePolicy,
  InstalledLiveAdmissionError,
  LIVE_MANAGER_SHA256,
  measureInstalledLiveTree,
} from '../dist/server/server/platform/live-design/installed-policy.js';
import {
  LIVE_CODEX_SOURCE,
  LIVE_CODEX_BWRAP_SHA256,
} from '../dist/server/server/platform/live-design/native-contract.js';
import { captureOwningRuntime } from '../dist/server/server/platform/live-design/owning-runtime-capture.js';
import { resolveLiveSourceInventory } from '../dist/server/server/platform/live-design/owning-source-inventory.js';
import { readLiveConfigFile } from '../dist/server/server/platform/live-design/effective-config.js';

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
// Unix endpoints have a ~108-byte limit. Keep the private endpoint out of the deep package path.
assert.ok(process.env.RUNNER_TEMP, 'Disposable runner temporary state required');
const socketController = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'l11-admin-'));
const socket = join(socketController, 'admin.sock');
assert.ok(Buffer.byteLength(socket) < 104, 'Private Unix endpoint path too long');
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
    mobileHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    expectedHead: process.env.LIVE_PROOF_EXPECTED_HEAD,
    mobileTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    sourceFiles: Object.fromEntries(
      [
        'scripts/live-model-tools-proof.mjs',
        'src/server/platform/codex/codex-process-launcher.ts',
        'src/server/platform/codex/session-runtime.ts',
        'src/server/platform/live-design/installed-policy.ts',
        'src/server/platform/live-design/native-contract.ts',
        'src/server/platform/live-design/owning-runtime-capture.ts',
        'src/server/platform/live-design/owning-source-inventory.ts',
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
  election,
  session,
  owningSessionId,
  childThreadId,
  rootCompleted = false,
  childCompleted = false,
  providerFailure = false;
let capture,
  policy,
  managedConfiguration,
  captureRevoked = false;
const proofStarted = Date.now();
const nativeMarkers = new Set();
const progress = setInterval(() => {
  try {
    const target = join(evidence, 'native-model-tools-progress.json');
    writeFileSync(
      target + '.next',
      JSON.stringify(
        {
          ...report,
          passed: false,
          inProgress: true,
          elapsedMs: Date.now() - proofStarted,
          native: {
            constructed: !!appServer,
            exitCode: appServer?.child.exitCode ?? null,
            exitedBySignal:
              appServer?.child.signalCode !== null && appServer?.child.signalCode !== undefined,
            writerOwned: runtime?.ownsWriter('l11-native-proof') ?? false,
            stderrMarkers: [...nativeMarkers].sort(),
          },
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    renameSync(target + '.next', target);
  } catch {
    /* Diagnostics never alter proof or resource ownership. */
  }
}, 5000);
progress.unref();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(condition, budget = 60000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(25);
  }
  throw Object.assign(new Error('NATIVE_PROOF_DEADLINE'), { code: 'NATIVE_PROOF_DEADLINE' });
}
async function readThread(id) {
  let timer;
  try {
    return await Promise.race([
      appServer.rpc.request('thread/read', { threadId: id, includeTurns: false }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('NATIVE_THREAD_READ_DEADLINE'), {
                code: 'NATIVE_THREAD_READ_DEADLINE',
              }),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function availableTools(tools, namespace) {
  return (tools ?? []).flatMap((tool) =>
    tool.type === 'namespace' ? availableTools(tool.tools, tool.name) : [{ ...tool, namespace }],
  );
}
async function prepareManagedInputs(env) {
  const installation = join(root, 'installed');
  const nodeRoot = join(installation, 'node-bin');
  mkdirSync(nodeRoot, { recursive: true, mode: 0o700 });
  const pin = (path) => ({ path: realpathSync(path), sha256: digest(readFileSync(path)) });
  const nodePath = join(nodeRoot, 'node');
  writeFileSync(nodePath, readFileSync(process.execPath), { mode: 0o500, flag: 'wx' });
  const node = pin(nodePath),
    manager = pin(process.env.LIVE_HOST_MANAGER_BINARY);
  assert.equal(manager.sha256, LIVE_MANAGER_SHA256);
  const agentsRoot = realpathSync(process.env.LIVE_HOST_AGENTS_ROOT);
  const agentsTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: agentsRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(agentsTree, '663799058b4c0146a74906061d0b334ae7c0d62c');
  const packages = ['context-mode', 'gestalt'].map((name) => {
    const target = join(installation, name);
    cpSync(join(agentsRoot, 'plugins', name), target, {
      recursive: true,
      filter: (path) =>
        !path
          .split('/')
          .some(
            (part) =>
              part === 'node_modules' ||
              part === 'build' ||
              part.startsWith('.context-mode-prepare'),
          ) && !path.endsWith('.bundle.mjs'),
    });
    return { name, root: target };
  });
  const { prepareLiveRuntime } = await import(
    pathToFileURL(join(installation, 'gestalt/scripts/prepare-live-runtime.mjs')).href
  );
  const prepared = await prepareLiveRuntime(
    join(installation, 'context-mode'),
    join(installation, 'context-runtime'),
  );
  const protect = (path) => {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) protect(join(path, name));
      chmodSync(path, 0o500);
    } else {
      assert.ok(stat.isFile());
      chmodSync(path, stat.mode & 0o111 ? 0o500 : 0o400);
    }
  };
  for (const entry of packages) {
    protect(entry.root);
    entry.sha256 = measureInstalledLiveTree(entry.root);
  }
  protect(prepared.root);
  const installationInputs = {
    manager,
    node,
    packages,
    runtime: { root: prepared.root, sha256: measureInstalledLiveTree(prepared.root) },
  };
  policy = new InstalledLivePolicy(installationInputs);
  policy.validateInstallation();
  managedConfiguration = {
    installation: installationInputs,
    native: pin(binary),
    nativeEnvironment: { ...env, HOME: nativeHome },
    providerCredentialEnvironment: [],
    privateDirectory: controller,
    components: {
      manager: '4ea4e0c92b156b6979eff04dbd9cdc9862674ea5',
      mobile: report.provenance.mobileTree,
      agents: agentsTree,
    },
    caddy: { controllerDirectory: socketController },
  };
  report.checks.actualAcceptedManagedInputs = true;
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
      .join('\n') ?? ''
  );
}
function providerCheck(stage, condition) {
  report.provider.stage = stage;
  assert.ok(condition);
}
async function requestRole(body) {
  providerCheck(
    'native-request-thread-identity',
    typeof body.client_metadata?.thread_id === 'string',
  );
  providerCheck(
    'native-request-session-identity',
    body.client_metadata?.session_id === owningSessionId,
  );
  const id = body.client_metadata.thread_id;
  if (id === session.threadId) return 'root';
  report.provider.stage = 'native-child-parent-reconciliation';
  const child = await readThread(id);
  providerCheck('native-child-parent', child.thread.parentThreadId === session.threadId);
  providerCheck('native-child-owning-session', child.thread.sessionId === owningSessionId);
  providerCheck('native-single-child', !childThreadId || childThreadId === id);
  childThreadId = id;
  report.checks.actualChildRequestReconciled = true;
  return 'child';
}
function nextEvent(body, role) {
  const step = roles.get(role) ?? 0;
  roles.set(role, step + 1);
  // This pinned model uses Responses Lite: actual tool specs live in additional_tools input.
  const tools = availableTools([
    ...(body.tools ?? []),
    ...(body.input ?? [])
      .filter((item) => item.type === 'additional_tools')
      .flatMap((item) => item.tools ?? []),
  ]);
  const codeMode = tools.find((item) => item.name === 'exec' && item.type === 'custom');
  const nested = (name) => codeMode?.description?.includes(`declare const tools: { ${name}(`);
  report.provider.lastCall = {
    role,
    step,
    requiredToolsAdvertised: Object.fromEntries(
      ['exec_command', 'apply_patch', 'spawn_agent'].map((name) => [
        name,
        tools.some((item) => item.name === name) || Boolean(nested(name)),
      ]),
    ),
    responsesLite: (body.input ?? []).some((item) => item.type === 'additional_tools'),
    codeModeAdvertised: Boolean(codeMode),
    childTaskMarkerVisible: userText(body.input).includes(childMarker),
  };
  const find = (name) => {
    const tool = tools.find((item) => item.name === name);
    providerCheck(`required-tool-${name}`, tool);
    return tool;
  };
  const commandCall = (id, args) => {
    const direct = tools.find((item) => item.name === 'exec_command');
    if (direct) return functionCall(direct, id, args);
    providerCheck('nested-native-exec-command', nested('exec_command'));
    return patchCall(codeMode, id, `text(await tools.exec_command(${JSON.stringify(args)}));`);
  };
  const editCall = (id, patch) => {
    const direct = tools.find((item) => item.name === 'apply_patch');
    if (direct) return patchCall(direct, id, patch);
    providerCheck('nested-native-apply-patch', nested('apply_patch'));
    return patchCall(codeMode, id, `text(await tools.apply_patch(${JSON.stringify(patch)}));`);
  };
  providerCheck('selected-model-preserved', body.model === 'gpt-6-sol');
  providerCheck('selected-thinking-preserved', body.reasoning?.effort === 'medium');
  const id = `${role}-${step}`;
  if (step === 1) {
    const output = body.input?.find(
      (item) =>
        ['function_call_output', 'custom_tool_call_output'].includes(item.type) &&
        item.call_id === `${role}-0`,
    );
    providerCheck(
      'native-command-denial-markers',
      output &&
        ['public-native-work', 'native-socket-denied', 'native-daemon-denied'].every((marker) =>
          JSON.stringify(output.output).includes(marker),
        ),
    );
  }
  if (step === 0) {
    const probe =
      'import socket,sys\np=socket.socket(socket.AF_UNIX)\ntry:\n p.connect(sys.argv[1]); print("native-socket-breach")\nexcept OSError as e:\n if e.errno in [1,2,13,20]: print("native-socket-denied")\n else: raise\n';
    const command = `cat ${shellQuote(join(app, 'public.txt'))}; cat ${shellQuote(privateFile)}; cat ${shellQuote(`/proc/${process.pid}/root${privateFile}`)}; cat ${shellQuote(`/proc/${process.pid}/fd/${privateFd}`)}; /usr/bin/python3 -c ${shellQuote(probe)} ${shellQuote(socket)}; if ls ${shellQuote(daemon)} >/dev/null 2>&1; then echo native-daemon-breach; else echo native-daemon-denied; fi`;
    return commandCall(id, {
      cmd: command,
      max_output_tokens: 1024,
      yield_time_ms: 1000,
    });
  }
  if (step === 1)
    return editCall(
      id,
      `*** Begin Patch\n*** Add File: ${join(app, `${role}-native-edit.txt`)}\n+permitted-native-edit\n*** End Patch`,
    );
  if (step === 2)
    return editCall(
      id,
      `*** Begin Patch\n*** Add File: ${join(controller, `${role}-forbidden-edit.txt`)}\n+forbidden-native-edit\n*** End Patch`,
    );
  if (role === 'root' && step === 3) {
    const spawn = find('spawn_agent');
    const properties = spawn.parameters?.properties ?? {};
    providerCheck('native-child-fork-schema', properties.fork_turns || properties.fork_context);
    return functionCall(spawn, id, {
      message: childMarker,
      agent_type: 'default',
      ...(properties.task_name ? { task_name: 'confinement_probe' } : {}),
      ...(properties.fork_turns ? { fork_turns: 'none' } : { fork_context: false }),
    });
  }
  if (role === 'root' && step === 4) {
    const result = body.input?.find(
      (item) => item.type === 'function_call_output' && item.call_id === 'root-3',
    );
    report.checks.nativeSpawnResponseObserved = Boolean(result);
    providerCheck('native-spawn-response-present', result);
    const text =
      typeof result.output === 'string'
        ? result.output
        : (result.output ?? []).map((item) => item.text ?? '').join('');
    report.provider.stage = 'native-spawn-result-json';
    const output = JSON.parse(text);
    providerCheck(
      'native-spawn-task-result',
      typeof output.task_name === 'string' && output.task_name.endsWith('/confinement_probe'),
    );
    report.checks.nativeSpawnTaskReturned = true;
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
    providerCheck(
      'responses-endpoint',
      request.method === 'POST' && request.url === '/v1/responses',
    );
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      providerCheck('compressed-request-bound', length < 4 * 1024 * 1024);
      chunks.push(chunk);
    }
    const compressed = Buffer.concat(chunks);
    const compression = request.headers['content-encoding'];
    const decoder = { gzip: gunzipSync, deflate: inflateSync, zstd: zstdDecompressSync }[
      compression
    ];
    providerCheck('request-compression', !compression || compression === 'identity' || decoder);
    report.provider.stage = 'request-decompression';
    const bytes = decoder ? decoder(compressed, { maxOutputLength: 4 * 1024 * 1024 }) : compressed;
    providerCheck('private-canary-absent', !bytes.includes(Buffer.from(privateCanary)));
    report.provider.stage = 'request-json';
    const body = JSON.parse(bytes);
    report.provider.requestCount++;
    providerCheck('request-count-bound', report.provider.requestCount <= 20);
    const id = `controlled-${report.provider.requestCount}`;
    const role = await requestRole(body);
    const event = nextEvent(body, role);
    report.provider.stage = 'responses-sse-write';
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const data of [
      { type: 'response.created', response: { id } },
      event,
      {
        type: 'response.completed',
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      },
    ])
      response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
    report.provider.stage = 'responses-sse-complete';
  } catch (error) {
    report.provider.failure = {
      stage: report.provider.stage,
      code: ['ERR_ASSERTION', 'NATIVE_THREAD_READ_DEADLINE'].includes(error?.code)
        ? error.code
        : 'UNCLASSIFIED',
    };
    providerFailure = true;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
try {
  report.stage = 'checkout-provenance';
  assert.equal(report.provenance.mobileHead, process.env.LIVE_PROOF_EXPECTED_HEAD);
  report.stage = 'admin-socket-bind';
  await new Promise((done, reject) => {
    admin.once('error', reject);
    admin.listen(socket, done);
  });
  report.stage = 'admin-socket-host-probe';
  await new Promise((done, reject) => {
    const peer = createConnection(socket);
    peer.once('error', reject);
    peer.once('end', done);
    peer.resume();
  });
  assert.equal(socketConnections, 1);
  report.checks.hostAdminSocketReachable = true;
  report.stage = 'provider-bind';
  await new Promise((done, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', done);
  });
  const providerPort = provider.address().port;
  report.stage = 'native-configuration';
  const config = `model = "gpt-6-sol"\nmodel_provider = "controlled"\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\ndefault_permissions = "workspace-git"\nmcp_servers = {}\nplugins = {}\n[model_providers.controlled]\nname = "Controlled native proof"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_snapshot = false\nshell_snapshot_v2 = false\ndaemon_auto_start = false\ncode_mode = false\nmulti_agent = true\nmulti_agent_v2 = true\nhooks = false\n[permissions.workspace-git]\nextends = ":workspace"\n[permissions.workspace-git.filesystem]\n":root" = "read"\n${JSON.stringify(app)} = "write"\n${JSON.stringify(controller)} = "deny"\n${JSON.stringify(socketController)} = "deny"\n${JSON.stringify(daemon)} = "deny"\n"/proc" = "deny"\n[permissions.workspace-git.network]\nenabled = false\n[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n`;
  writeFileSync(join(nativeHome, 'config.toml'), config, { mode: 0o600 });
  const env = {
    PATH: `${dirname(process.execPath)}:${dirname(binary)}:/usr/bin:/bin`,
    HOME: root,
    CODEX_HOME: nativeHome,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
  };
  execFileSync('git', ['init', '--quiet', app], { stdio: 'ignore' });
  // The shared capture prepares the real writable model-output leaves beneath
  // this control parent; no helper records or provenance metadata are created.
  mkdirSync(join(app, '.impeccable/live'), { recursive: true, mode: 0o700 });
  report.stage = 'managed-native-inputs';
  await prepareManagedInputs(env);
  election = await electLiveController({
    privateDirectory: controller,
    controllerId: 'native-proof-controller',
    initialize: true,
  });
  const owningApp = {
    appRoot: app,
    owningPolicy: {
      profileId: 'workspace-git',
      configFiles: [readLiveConfigFile(join(nativeHome, 'config.toml'))],
      instructionFiles: [],
      sandboxState: {
        permissionProfile: {
          type: 'managed',
          network: 'restricted',
          file_system: {
            type: 'restricted',
            entries: [
              { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
              { path: { type: 'special', value: { kind: 'slash_tmp' } }, access: 'write' },
              { path: { type: 'path', path: '/tmp' }, access: 'write' },
              { path: { type: 'path', path: app }, access: 'write' },
              ...[controller, socketController, daemon, '/proc'].map((path) => ({
                path: { type: 'path', path },
                access: 'deny',
              })),
            ],
          },
        },
        sandboxCwd: pathToFileURL(app).href,
        useLegacyLandlock: false,
      },
    },
  };
  let launches = 0;
  const runtimeArguments = [
    (input) => {
      launches++;
      assert.equal(launches, 1);
      appServer = launchCodexAppServer(input, {
        executable: binary,
        sha256: LIVE_CODEX_SHA256,
        environment: env,
        managedLaunch: {
          command: managedConfiguration.installation.manager.path,
          args: [
            'cli',
            '--',
            '--live-policy-owning-runtime',
            '--manifest',
            capture.manifestPath,
            '--capture-id',
            capture.captureId,
          ],
        },
      });
      appServer.child.stderr.on('data', (bytes) => {
        const lower = bytes.toString('utf8').toLowerCase();
        for (const marker of [
          'plugin',
          'context-mode',
          'missing',
          'config',
          'not found',
          'failed',
          'permission denied',
          'usage',
          'expected',
          'unsafe',
          'discovery',
          'diagnostic',
          'shell snapshot',
          'bwrap',
          'refused',
        ])
          if (lower.includes(marker)) nativeMarkers.add(marker);
      });
      return appServer;
    },
    undefined,
    (_sessionId, notification) => {
      if (
        notification.method === 'turn/completed' &&
        childThreadId &&
        notification.params?.threadId === childThreadId
      ) {
        const status = notification.params?.turn?.status;
        report.nativeChildTurn = {
          status: ['completed', 'failed', 'interrupted'].includes(status) ? status : 'unknown',
        };
        if (status !== 'completed') providerFailure = true;
      }
      if (
        notification.method === 'turn/completed' &&
        notification.params?.threadId === session?.threadId
      ) {
        const status = notification.params?.turn?.status;
        report.nativeTurn = {
          status: ['completed', 'failed', 'interrupted'].includes(status) ? status : 'unknown',
        };
        if (status === 'completed') rootCompleted = true;
        else providerFailure = true;
      }
    },
  ];
  runtimeArguments[16] = async (owning, input, threadConfig) => {
    assert.equal(capture, undefined, 'Only one original capture is permitted');
    report.stage = 'original-runtime-capture';
    capture = await captureOwningRuntime({
      configuration: managedConfiguration,
      app: owningApp,
      session: owning,
      election: election.election,
      generation: 1,
      authenticationDirectory: controller,
      threadConfig,
    });
    return { ...input, liveCaptureId: capture.captureId };
  };
  runtime = new CodexSessionRuntime(...runtimeArguments);
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
  report.stage = 'original-runtime-source-seal';
  const workerConfig = readLiveConfigFile(join(capture.runtimeHome, 'config.toml'));
  const sources = resolveLiveSourceInventory({
    captured: capture.captured,
    configuration: admitted.configuration,
    threadConfig: admitted.threadConfig,
    selection: {
      ...admitted.threadSelection,
      threadConfig: admitted.threadConfig,
      skillsConfig: admitted.skillsConfig ?? null,
    },
    runtime: admitted.launch,
    policyDigest: capture.policyDigest,
    workerConfig,
    approved: { mcpServers: {}, plugins: {} },
  });
  const sourcesPath = join(capture.directory, 'owning-sources.json');
  writeFileSync(sourcesPath, JSON.stringify(sources) + '\n', { mode: 0o600, flag: 'wx' });
  await policy.sealRuntime(
    capture.manifestPath,
    capture.captureId,
    admitted.launch.pid,
    sourcesPath,
  );
  const manifest = JSON.parse(readFileSync(capture.manifestPath, 'utf8'));
  manifest.runtimeProvenance = {
    captureId: capture.captureId,
    effectiveConfigDigest: sources.effectiveConfigDigest,
    sessionFlagsDigest: sources.sessionFlagsDigest,
  };
  writeFileSync(capture.manifestPath + '.next', JSON.stringify(manifest) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(capture.manifestPath + '.next', capture.manifestPath);
  const managerCommand = (action) =>
    JSON.parse(
      execFileSync(
        managedConfiguration.installation.manager.path,
        ['live-policy', action, '--manifest', capture.manifestPath],
        {
          cwd: capture.directory,
          env: {
            PATH: `${dirname(managedConfiguration.installation.node.path)}:/usr/bin:/bin`,
            HOME: capture.runtimeHome,
            LANG: 'C.UTF-8',
          },
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 16384,
        },
      ),
    );
  assert.equal(managerCommand('prepare').available, true);
  assert.equal(managerCommand('verify').available, true);
  report.checks.originalOwningBirthAndSourcesSealed = true;
  owningSessionId = admitted.thread.thread.sessionId;
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
  report.stage = 'wait-root-and-child-model-completion';
  await until(() => providerFailure || (rootCompleted && childCompleted));
  assert.equal(providerFailure, false);
  report.stage = 'wait-child-source-edit';
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
  report.stage = 'child-owning-runtime-roster';
  const roster = await runtime.inspectLiveSpawnedChildren(session);
  assert.deepEqual(roster.launch, admitted.launch);
  report.stage = 'child-roster-count';
  assert.equal(roster.threads.length, 1);
  report.stage = 'child-roster-request-identity';
  assert.equal(roster.threads[0].id, childThreadId);
  report.stage = 'child-thread-read';
  const child = await appServer.rpc.request('thread/read', {
    threadId: childThreadId,
    includeTurns: false,
  });
  report.stage = 'child-parent-identity';
  assert.equal(child.thread.parentThreadId, session.threadId);
  report.stage = 'child-session-identity';
  assert.equal(child.thread.sessionId, admitted.thread.thread.sessionId);
  report.stage = 'child-selected-model';
  assert.equal(child.thread.model, session.model);
  report.stage = 'child-selected-thinking';
  assert.equal(child.thread.reasoningEffort, 'medium');
  report.stage = 'child-model-call-count';
  assert.equal(roles.get('child'), 4);
  report.stage = 'wait-child-native-idle';
  await until(async () => {
    const current = await appServer.rpc.request('thread/read', {
      threadId: childThreadId,
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
  report.stage = 'elected-owning-runtime-handoff';
  const childProcess = appServer.child;
  // Completion is grounded in the actual native notification and terminal reads above.
  session = RelaySession.rehydrate(session).completeTurn(
    session.activeTurnId,
    new Date().toISOString(),
  ).snapshot;
  let handoff = election.ownership.claim({
    relayId: session.id,
    appId: 'native-proof-app',
    rootThreadId: session.threadId,
    provider: 'codex',
    app: liveAppIdentity(app),
    targetId: 'native-proof-fixed-target',
    targetIdentity: 'native-proof-fixed-process',
    operationId: 'native-proof-handoff',
    authSessionHash: 'native-proof-auth',
    deviceId: 'native-proof-device',
    previewOrigin: 'https://native-proof.test',
  }).run;
  handoff = election.ownership.mutate(handoff, { event: 'phase', phase: 'quiesce:intent' });
  await policy.revokeRuntime(capture.manifestPath, capture.captureId);
  captureRevoked = true;
  await runtime.releaseLiveOwner(session, { owners: election.ownership, fence: handoff });
  await until(() => childProcess.exitCode !== null || childProcess.signalCode !== null, 10000);
  assert.equal(launches, 1);
  report.checks.electedOwnerNativeUnloadAndExit = true;
  report.checks.ownedRuntimeExited = true;
  report.passed = true;
  report.stage = 'complete';
} catch (error) {
  const codes = new Set([
    'EINVAL',
    'ENAMETOOLONG',
    'ENOENT',
    'EACCES',
    'EPERM',
    'EADDRINUSE',
    'ERR_ASSERTION',
    'LIVE_RUNTIME_BINARY_UNVERIFIED',
    'LIVE_RUNTIME_BOOTSTRAP_UNAVAILABLE',
    'LIVE_RUNTIME_CAPTURE_REPLY_INVALID',
    'LIVE_ADMISSION_UNAVAILABLE',
    'LIVE_CONFIG_CHANGED',
    'LIVE_EFFECTIVE_CONFIG_UNAVAILABLE',
    'LIVE_OWNING_POLICY_UNVERIFIED',
    'LIVE_PRIVATE_STATE_INVALID',
    'LIVE_UNAPPROVED_LAUNCH_SURFACE',
    'LIVE_PROCESS_IDENTITY_UNAVAILABLE',
    'NATIVE_PROOF_DEADLINE',
    'NATIVE_THREAD_READ_DEADLINE',
    'LIVE_RUNTIME_QUIESCENCE_UNAVAILABLE',
    'LIVE_RUNTIME_UNLOAD_UNVERIFIED',
    'LIVE_RUNTIME_IDENTITY_CHANGED',
    'LIVE_SESSION_BUSY',
    'LIVE_CHILD_TOPOLOGY_UNAVAILABLE',
    'LIVE_CONTROLLER_BUSY',
    'LIVE_CONTROLLER_UNAVAILABLE',
    'LIVE_GENERATION_STALE',
  ]);
  report.failure = {
    code: codes.has(error?.code)
      ? error.code
      : codes.has(error?.message)
        ? error.message
        : 'UNCLASSIFIED',
  };
  if (error instanceof InstalledLiveAdmissionError) report.failure.admission = error.diagnostic;
  report.waitState = {
    rootCompleted,
    childModelCompletionEmitted: childCompleted,
    actualChildRequestReconciled: Boolean(childThreadId),
    rootRequestCount: roles.get('root') ?? 0,
    childRequestCount: roles.get('child') ?? 0,
    rootSourceEditPresent: existsSync(join(app, 'root-native-edit.txt')),
    childSourceEditPresent: existsSync(join(app, 'child-native-edit.txt')),
  };
  process.exitCode = 1;
} finally {
  report.cleanupStage = 'capture-revoke';
  if (capture && !captureRevoked) {
    try {
      await policy.revokeRuntime(capture.manifestPath, capture.captureId);
      captureRevoked = true;
    } catch {
      report.passed = false;
      report.cleanupFailure = 'NATIVE_CAPTURE_REVOCATION_UNVERIFIED';
    }
  }
  report.cleanupStage = 'runtime-stop';
  runtime?.stopAll();
  report.cleanupStage = 'election-close';
  await election?.close();
  report.cleanupStage = 'provider-close';
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  report.cleanupStage = 'admin-close';
  await new Promise((done) => admin.close(done));
  rmSync(socketController, { recursive: true, force: true });
  closeSync(privateFd);
  report.cleanupStage = 'settled';
  clearInterval(progress);
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
      failure: report.failure ?? null,
      provider: 'deterministic',
      genuine: false,
    }) + '\n',
  );
  if (!appServer || appServer.child.exitCode !== null || appServer.child.signalCode !== null)
    rmSync(root, { recursive: true, force: true });
}
