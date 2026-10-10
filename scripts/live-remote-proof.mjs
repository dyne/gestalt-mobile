/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Disposable hosted-runner integration fixture. Never edits operator state or a published runtime.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildApp } from '../dist/server/server/app.js';
import { createRelyingPartyConfig } from '../dist/server/server/config.js';
import { SqliteAuthorizationStore } from '../dist/server/server/platform/auth/sqlite-authorization-store.js';
import { SimpleWebAuthnAdapter } from '../dist/server/server/platform/auth/simple-webauthn-adapter.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
} from '../dist/server/server/features/auth/domain/identifiers.js';
import { SqlitePreviewGrantStore } from '../dist/server/server/platform/live-design/sqlite-preview-grant-store.js';
import {
  previewAuthentication,
  previewSecrets,
} from '../dist/server/server/platform/live-design/preview-secrets.js';
import { PreviewConnections } from '../dist/server/server/platform/live-design/preview-connections.js';
import { createPreviewGateway } from '../dist/server/server/platform/live-design/preview-gateway.js';
import { CaddyRouteStore } from '../dist/server/server/platform/live-design/caddy-route-store.js';
import { CaddyRoutes } from '../dist/server/server/platform/live-design/caddy-routes.js';
import { CaddyRouteBroker } from '../dist/server/server/platform/live-design/caddy-route-broker.js';
import { UnixCaddyAdmin } from '../dist/server/server/platform/live-design/caddy-admin.js';
import {
  ManagedCaddyAdminBoundary,
  protectCaddyControllerState,
} from '../dist/server/server/platform/live-design/caddy-admin-boundary.js';
import { RegisteredPreviewTargets } from '../dist/server/server/platform/live-design/preview-targets.js';

assert.equal(process.env.LIVE_REMOTE_PROOF, '1', 'Requires explicit disposable-runner opt-in');
const caddy = process.env.LIVE_TEST_CADDY;
const codex = process.env.LIVE_TEST_CODEX;
const runtime = process.env.LIVE_PUBLISHED_RUNTIME;
const evidence = resolve(process.env.LIVE_CADDY_EVIDENCE_DIR ?? 'test-results/live-caddy-proof');
assert.ok(caddy && codex && runtime, 'Pinned proof tools are required');
assert.equal(
  createHash('sha256')
    .update(await readFile(runtime))
    .digest('hex'),
  '65e619d4126e3d3fd10fc5bb7a43d332fe327dbc38e0085883d920a2ba752898',
);
const root = await mkdtemp(join(tmpdir(), 'gestalt-remote-proof-'));
const controller = join(root, 'controller');
const project = join(root, 'project');
const secondProject = join(root, 'second-project');
const published = join(root, 'published');
const browserHome = join(controller, 'browser-home');
const browserTemporaryDirectory = join(controller, 'browser-tmp');
for (const dir of [controller, project, published, browserHome, evidence])
  await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir(browserTemporaryDirectory, { mode: 0o700 });
const cleanup = [];
const namespace = `live-${process.pid}`;
const hostInterface = `lvh${process.pid}`;
const peerInterface = `lvb${process.pid}`;
const hostAddress = '10.231.19.1';
const browserAddress = '10.231.19.2';
const mobileHost = 'mobile.live.test';
const previewHost = 'preview.live.test';
function run(bin, args, options = {}) {
  try {
    return execFileSync(bin, args, { stdio: 'pipe', timeout: 120000, ...options });
  } catch {
    // Child command arguments/output can contain the helper token; never publish them.
    throw new Error(`Isolated proof operation failed (${bin.split('/').pop()})`);
  }
}
function sudo(args) {
  return run('sudo', ['--non-interactive', ...args]);
}
function child(bin, args, options = {}) {
  const processChild = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  // No helper tokens, launch grants or raw upstream/browser logs enter evidence.
  processChild.stdout.on('data', () => {});
  processChild.stderr.on('data', () => {});
  cleanup.push(async () => {
    if (processChild.exitCode !== null) return;
    processChild.kill('SIGTERM');
    await Promise.race([
      new Promise((done) => processChild.once('exit', done)),
      new Promise((done) => setTimeout(done, 2000)),
    ]);
    if (processChild.exitCode === null) processChild.kill('SIGKILL');
  });
  return processChild;
}
async function port() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const value = listener.address().port;
  await new Promise((done) => listener.close(done));
  return value;
}
async function ready(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if (await check()) return;
    } catch {
      /* Owned startup only. */
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${label} did not become ready`);
}
try {
  // Namespace setup is confined to this disposable hosted runner and always removed below.
  sudo(['ip', 'netns', 'add', namespace]);
  cleanup.push(async () => {
    const pids = sudo(['ip', 'netns', 'pids', namespace])
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    assert.ok(pids.every((pid) => /^[1-9][0-9]*$/.test(pid)));
    if (pids.length) {
      try {
        sudo(['kill', '-TERM', '--', ...pids]);
      } catch {
        /* Owned processes may already have exited. */
      }
    }
    sudo(['ip', 'netns', 'delete', namespace]);
  });
  sudo(['ip', 'link', 'add', hostInterface, 'type', 'veth', 'peer', 'name', peerInterface]);
  cleanup.push(async () => {
    try {
      sudo(['ip', 'link', 'delete', hostInterface]);
    } catch {
      /* Netns deletion may remove peer. */
    }
  });
  sudo(['ip', 'link', 'set', peerInterface, 'netns', namespace]);
  sudo(['ip', 'address', 'add', `${hostAddress}/30`, 'dev', hostInterface]);
  sudo(['ip', 'link', 'set', hostInterface, 'up']);
  sudo([
    'ip',
    'netns',
    'exec',
    namespace,
    'ip',
    'address',
    'add',
    `${browserAddress}/30`,
    'dev',
    peerInterface,
  ]);
  sudo(['ip', 'netns', 'exec', namespace, 'ip', 'link', 'set', peerInterface, 'up']);
  sudo(['ip', 'netns', 'exec', namespace, 'ip', 'link', 'set', 'lo', 'up']);
  const serverNetwork = await readlink('/proc/self/ns/net');
  const browserNetwork = sudo(['ip', 'netns', 'exec', namespace, 'readlink', '/proc/self/ns/net'])
    .toString()
    .trim();
  assert.notEqual(serverNetwork, browserNetwork);
  run('tar', ['-xzf', runtime, '-C', published, 'impeccable', 'source.tar.gz']);
  const engine = join(published, 'impeccable');
  assert.equal(
    createHash('sha256')
      .update(await readFile(engine))
      .digest('hex'),
    '81fe24a7430571de1003f34fecf787bdc0acefa1be80525ccea9d4b74b5441a0',
  );
  run('tar', [
    '-xzf',
    join(published, 'source.tar.gz'),
    '-C',
    published,
    'tests/framework-fixtures/vite8-react-ts',
    'tests/live-e2e/ui.mjs',
  ]);
  await cp(join(published, 'tests/framework-fixtures/vite8-react-ts/files'), project, {
    recursive: true,
  });
  run('git', ['init', '--quiet'], { cwd: project });
  const fixture = JSON.parse(
    await readFile(join(published, 'tests/framework-fixtures/vite8-react-ts/fixture.json'), 'utf8'),
  );
  await mkdir(join(project, '.impeccable/live'), { recursive: true });
  await writeFile(join(project, '.impeccable/live/config.json'), JSON.stringify(fixture.config));
  run('npm', ['install', '--no-audit', '--no-fund', '--include=optional'], { cwd: project });
  await cp(join(published, 'tests/framework-fixtures/vite8-react-ts/files'), secondProject, {
    recursive: true,
  });
  run('git', ['init', '--quiet'], { cwd: secondProject });
  await symlink(join(project, 'node_modules'), join(secondProject, 'node_modules'));
  await mkdir(join(secondProject, '.impeccable/live'), { recursive: true });
  await writeFile(
    join(secondProject, '.impeccable/live/config.json'),
    JSON.stringify(fixture.config),
  );
  await mkdir(join(secondProject, 'public'));
  await writeFile(
    join(secondProject, 'public/cross-port-canary.js'),
    'window.__crossPortScriptLoaded=true;',
  );
  await writeFile(
    join(secondProject, 'public/cross-port-canary.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>',
  );
  await cp(join(project, 'package-lock.json'), join(evidence, 'fixture-package-lock.json'));
  const [
    previewPort,
    mobilePort,
    appPort,
    helperPort,
    gatewayPort,
    mobileGatewayPort,
    secondPreviewPort,
    secondAppPort,
    secondHelperPort,
    secondGatewayPort,
  ] = await Promise.all(Array.from({ length: 10 }, port));
  assert.equal(
    new Set([
      previewPort,
      mobilePort,
      appPort,
      helperPort,
      gatewayPort,
      mobileGatewayPort,
      secondPreviewPort,
      secondAppPort,
      secondHelperPort,
      secondGatewayPort,
    ]).size,
    10,
  );
  const previewOrigin = `https://${previewHost}:${previewPort}`;
  const secondPreviewOrigin = `https://${previewHost}:${secondPreviewPort}`;
  const mobileOrigin = `https://${mobileHost}:${mobilePort}`;
  await writeFile(
    join(project, 'vite.config.ts'),
    `import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:${appPort},strictPort:true,allowedHosts:['127.0.0.1'],hmr:{protocol:'wss',host:'${previewHost}',clientPort:${previewPort}}}});`,
  );
  await writeFile(
    join(secondProject, 'vite.config.ts'),
    `import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],cacheDir:'.vite-cache',server:{host:'127.0.0.1',port:${secondAppPort},strictPort:true,allowedHosts:['127.0.0.1'],hmr:{protocol:'wss',host:'${previewHost}',clientPort:${secondPreviewPort}}}});`,
  );
  // Explicit 100% user font size; only the disposable upstream fixture copy is changed.
  await writeFile(
    join(project, 'src/styles.css'),
    `${await readFile(join(project, 'src/styles.css'), 'utf8')}\nhtml{font-size:100%}\n`,
  );
  const openssl = (args) => run('openssl', args, { cwd: controller });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=Gestalt disposable Live proof CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'tls.key',
    '-out',
    'tls.csr',
    '-subj',
    `/CN=${previewHost}`,
  ]);
  await writeFile(
    join(controller, 'extensions'),
    `subjectAltName=DNS:${previewHost},DNS:${mobileHost}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  openssl([
    'x509',
    '-req',
    '-in',
    'tls.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'tls.pem',
    '-days',
    '2',
    '-extfile',
    'extensions',
  ]);
  await mkdir(join(browserHome, '.pki/nssdb'), { recursive: true });
  run('certutil', ['-N', '--empty-password', '-d', `sql:${browserHome}/.pki/nssdb`]);
  run('certutil', [
    '-A',
    '-n',
    'Gestalt disposable proof CA',
    '-t',
    'C,,',
    '-i',
    join(controller, 'ca.pem'),
    '-d',
    `sql:${browserHome}/.pki/nssdb`,
  ]);
  const socket = join(controller, 'admin.sock');
  const config = {
    admin: { listen: `unix/${socket}|0600`, config: { persist: false } },
    logging: { logs: { default: { level: 'ERROR' } } },
    apps: {
      tls: {
        certificates: {
          load_files: [
            { certificate: join(controller, 'tls.pem'), key: join(controller, 'tls.key') },
          ],
        },
      },
      http: {
        servers: {
          mobile: {
            listen: [`${hostAddress}:${mobilePort}`],
            tls_connection_policies: [{}],
            automatic_https: { disable: true },
            routes: [
              {
                match: [{ host: [mobileHost] }],
                handle: [
                  {
                    handler: 'reverse_proxy',
                    upstreams: [{ dial: `127.0.0.1:${mobileGatewayPort}` }],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
  const configPath = join(controller, 'caddy.json');
  await writeFile(configPath, JSON.stringify(config));
  child(caddy, ['run', '--config', configPath], {
    env: {
      ...process.env,
      XDG_DATA_HOME: join(controller, 'caddy-data'),
      XDG_CONFIG_HOME: join(controller, 'caddy-state'),
    },
  });
  const admin = new UnixCaddyAdmin(socket);
  await ready(
    async () => (await admin.request('GET', '/config/apps/http/servers')).status === 200,
    'Caddy',
  );
  const credential = randomBytes(32).toString('hex');
  const credentialPath = join(controller, 'broker-credential');
  await writeFile(credentialPath, credential, { mode: 0o600 });
  const codexHome = join(controller, 'codex');
  await mkdir(codexHome, { mode: 0o700 });
  const policy = protectCaddyControllerState(
    {
      permissionProfile: {
        type: 'managed',
        file_system: {
          type: 'restricted',
          entries: [
            { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
            { path: { type: 'path', path: project }, access: 'write' },
            { path: { type: 'special', value: { kind: 'slash_tmp' } }, access: 'write' },
          ],
        },
        network: 'enabled',
      },
      sandboxCwd: pathToFileURL(project).href,
      useLegacyLandlock: false,
    },
    controller,
  );
  const sandboxEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_HOME: codexHome,
    IMPECCABLE_LIVE_PUBLIC_BASE_URL: `${previewOrigin}/__gestalt_live/`,
    IMPECCABLE_LIVE_COPY_AGENT: 'chat',
  };
  const sandboxArgs = (args) => [
    'sandbox',
    '--sandbox-state-json',
    JSON.stringify(policy),
    '--',
    ...args,
  ];
  const boundary = new ManagedCaddyAdminBoundary({
    codexExecutable: codex,
    projectDirectory: project,
    controllerDirectory: controller,
    socketPath: socket,
    credentialPath,
    effectiveSandboxState: () => policy,
    sandboxEnvironment: sandboxEnv,
  });
  const actualProjectDenial = await boundary.verify();
  const secondPolicy = {
    ...policy,
    sandboxCwd: pathToFileURL(secondProject).href,
    permissionProfile: {
      ...policy.permissionProfile,
      file_system: {
        ...policy.permissionProfile.file_system,
        entries: policy.permissionProfile.file_system.entries.map((entry) =>
          entry.path.type === 'path' && entry.path.path === project
            ? { ...entry, path: { ...entry.path, path: secondProject } }
            : entry,
        ),
      },
    },
  };
  const secondSandboxEnv = {
    ...sandboxEnv,
    IMPECCABLE_LIVE_PUBLIC_BASE_URL: `${secondPreviewOrigin}/__gestalt_live/`,
  };
  const secondSandboxArgs = (args) => [
    'sandbox',
    '--sandbox-state-json',
    JSON.stringify(secondPolicy),
    '--',
    ...args,
  ];
  const secondBoundary = new ManagedCaddyAdminBoundary({
    codexExecutable: codex,
    projectDirectory: secondProject,
    controllerDirectory: controller,
    socketPath: socket,
    credentialPath,
    effectiveSandboxState: () => secondPolicy,
    sandboxEnvironment: secondSandboxEnv,
  });
  const secondProjectDenial = await secondBoundary.verify();
  const engineRun = async (args) => {
    try {
      const result = await promisify(execFile)(codex, sandboxArgs([engine, ...args]), {
        cwd: project,
        env: sandboxEnv,
        timeout: 20000,
      });
      return result.stdout;
    } catch {
      throw new Error('Managed helper command failed');
    }
  };
  // Both actual managed project processes use the exact verified effective policy.
  child(codex, sandboxArgs([engine, 'live-server', `--port=${helperPort}`]), {
    cwd: project,
    env: sandboxEnv,
  });
  await ready(
    async () => (await fetch(`http://127.0.0.1:${helperPort}/health`)).ok,
    'published helper',
  );
  const helperState = JSON.parse(
    await readFile(join(project, '.impeccable/live/server.json'), 'utf8'),
  );
  assert.ok(helperState.token);
  await engineRun(['live-inject', '--port', String(helperPort), '--token', helperState.token]);
  child(codex, sandboxArgs([process.execPath, join(project, 'node_modules/vite/bin/vite.js')]), {
    cwd: project,
    env: sandboxEnv,
  });
  await ready(async () => (await fetch(`http://127.0.0.1:${appPort}/`)).ok, 'actual Vite fixture');
  child(codex, secondSandboxArgs([engine, 'live-server', `--port=${secondHelperPort}`]), {
    cwd: secondProject,
    env: secondSandboxEnv,
  });
  await ready(
    async () => (await fetch(`http://127.0.0.1:${secondHelperPort}/health`)).ok,
    'second published helper',
  );
  const secondHelperState = JSON.parse(
    await readFile(join(secondProject, '.impeccable/live/server.json'), 'utf8'),
  );
  run(
    codex,
    secondSandboxArgs([
      engine,
      'live-inject',
      '--port',
      String(secondHelperPort),
      '--token',
      secondHelperState.token,
    ]),
    { cwd: secondProject, env: secondSandboxEnv },
  );
  child(
    codex,
    secondSandboxArgs([process.execPath, join(secondProject, 'node_modules/vite/bin/vite.js')]),
    { cwd: secondProject, env: secondSandboxEnv },
  );
  await ready(
    async () => (await fetch(`http://127.0.0.1:${secondAppPort}/`)).ok,
    'second actual Vite fixture',
  );
  const routeStore = new CaddyRouteStore(
    join(controller, 'origins.sqlite'),
    previewHost,
    [previewPort, secondPreviewPort],
    { initialize: true },
  );
  cleanup.push(async () => routeStore.close());
  const targets = new RegisteredPreviewTargets();
  const registrationId = targets.register({ appRoot: project, appPort, helperPort, gatewayPort });
  const assignment = routeStore.assign(project);
  const secondRegistrationId = targets.register({
    appRoot: secondProject,
    appPort: secondAppPort,
    helperPort: secondHelperPort,
    gatewayPort: secondGatewayPort,
  });
  const secondAssignment = routeStore.assign(secondProject);
  const rp = createRelyingPartyConfig(mobileOrigin);
  const auth = new SqliteAuthorizationStore(controller, rp);
  auth.initializeOwner(randomBytes(32));
  cleanup.push(async () => auth.close());
  const grants = new SqlitePreviewGrantStore(controller);
  cleanup.push(async () => grants.close());
  const authentication = previewAuthentication(auth);
  const audiences = new Map();
  const instance = {
    relayId: 'remote-proof',
    appId: 'vite-fixture',
    liveId: 'real-helper',
    generation: 1,
    previewOrigin,
  };
  const secondInstance = {
    relayId: 'second-remote-proof',
    appId: 'second-vite-fixture',
    liveId: 'second-real-helper',
    generation: 1,
    previewOrigin: secondPreviewOrigin,
  };
  const deps = {
    store: grants,
    secrets: previewSecrets,
    authentication,
    owners: { read: (id) => audiences.get(id) ?? null },
    now: () => new Date(),
    mobileOrigin,
  };
  const connections = new PreviewConnections(deps);
  deps.revocations = connections;
  cleanup.push(async () => connections.close());
  const mobile = await buildApp({
    liveDesign: deps,
    auth: {
      repository: auth,
      revocations: {
        sessionRevoked: (session) =>
          connections.revoke({ authSessionHash: previewSecrets.hash(session) }),
        deviceRevoked: (deviceId) => connections.revoke({ deviceId }),
      },
      clock: { now: deps.now },
      random: { bytes: (size) => randomBytes(size) },
      identifiers: {
        sessionId: () => authorizationSessionId(previewSecrets.token()),
        deviceId: () => authorizedDeviceId(randomUUID()),
      },
      relyingParty: rp,
      webauthn: new SimpleWebAuthnAdapter(),
    },
    health: {
      read: async () => ({
        status: 'ok',
        version: 'remote-proof',
        codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
      }),
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  mobile.addHook('onRequest', async (request) => {
    const selected = [instance, secondInstance].find(
      (candidate) => request.url === `/api/sessions/${candidate.relayId}/live/launch-grants`,
    );
    if (selected && !audiences.has(selected.relayId)) {
      const identity = authentication.identity(request.headers.cookie, deps.now().toISOString());
      if (identity) audiences.set(selected.relayId, { ...selected, ...identity, active: true });
    }
  });
  mobile.get('/', async (_request, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><html><title>Gestalt Mobile proof</title><h1>Gestalt Mobile</h1><button id="launch">Open Live preview</button></html>',
      ),
  );
  await mobile.listen({ host: '127.0.0.1', port: mobileGatewayPort });
  cleanup.push(async () => mobile.close());
  const gateway = await createPreviewGateway({
    deps,
    instance,
    assignment,
    targets,
    registrationId,
    connections,
  });
  const upgradeObservations = [];
  gateway.app.server.on('upgrade', (request) => {
    upgradeObservations.push({
      path: (request.url ?? '/').split('?')[0],
      host: request.headers.host,
      origin: request.headers.origin,
      secFetchSite: request.headers['sec-fetch-site'] ?? null,
      secFetchMode: request.headers['sec-fetch-mode'] ?? null,
      hasCookie: Boolean(request.headers.cookie),
      protocol: request.headers['sec-websocket-protocol'],
    });
  });
  await gateway.listen();
  cleanup.push(async () => gateway.close());
  const secondGateway = await createPreviewGateway({
    deps,
    instance: secondInstance,
    assignment: secondAssignment,
    targets,
    registrationId: secondRegistrationId,
    connections,
  });
  const crossPortObservations = [];
  secondGateway.app.addHook('onSend', async (request, reply, payload) => {
    const path = (request.raw.url ?? '/').split('?')[0];
    if (
      ['/cross-port-canary.js', '/cross-port-canary.svg', '/'].includes(path) &&
      reply.statusCode === 403
    ) {
      crossPortObservations.push({
        path,
        status: reply.statusCode,
        origin: request.headers.origin ?? null,
        secFetchSite: request.headers['sec-fetch-site'] ?? null,
        secFetchMode: request.headers['sec-fetch-mode'] ?? null,
        secFetchDest: request.headers['sec-fetch-dest'] ?? null,
        cookieNames: (request.headers.cookie ?? '')
          .split(';')
          .map((part) => part.trim().split('=')[0]),
      });
    }
    return payload;
  });
  await secondGateway.listen();
  cleanup.push(async () => secondGateway.close());
  // On failed browser flows, revoke streams before Fastify waits for listener closure.
  cleanup.push(async () => connections.close());
  const broker = new CaddyRouteBroker(
    credential,
    new CaddyRoutes(admin, routeStore, targets),
    boundary,
  );
  await broker.execute(credential, { action: 'activate', appRoot: project, registrationId });
  await broker.execute(credential, {
    action: 'activate',
    appRoot: secondProject,
    registrationId: secondRegistrationId,
  });
  const browserConfig = {
    previewOrigin,
    secondPreviewOrigin,
    mobileOrigin,
    helperPort,
    secondHelperPort,
    evidence,
    browserHome,
    hostAddress,
    uiModule: join(published, 'tests/live-e2e/ui.mjs'),
    serverNetwork,
    browserNetwork,
  };
  const configFile = join(root, 'browser.json');
  await writeFile(configFile, JSON.stringify(browserConfig));
  const browser = spawn(
    'sudo',
    [
      '--non-interactive',
      'ip',
      'netns',
      'exec',
      namespace,
      'setpriv',
      `--reuid=${process.getuid()}`,
      `--regid=${process.getgid()}`,
      '--init-groups',
      'env',
      `HOME=${browserHome}`,
      `TMPDIR=${browserTemporaryDirectory}`,
      `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME, '.cache/ms-playwright')}`,
      process.execPath,
      resolve('scripts/live-remote-browser.mjs'),
      configFile,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: browserHome,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      },
    },
  );
  cleanup.push(async () => {
    browser.kill('SIGTERM');
  });
  let browserFailure = '';
  browser.stderr.on('data', (chunk) => {
    const sanitized = String(chunk).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, (value) => {
      try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return '[URL omitted]';
      }
    });
    browserFailure = (browserFailure + sanitized).slice(-2000);
  });
  const lines = createInterface({ input: browser.stdout });
  let browserResult;
  let processing = Promise.resolve();
  lines.on('line', (line) => {
    processing = processing
      .then(async () => {
        const message = JSON.parse(line);
        if (message.checkpoint) {
          assert.ok(
            [
              'enrolled',
              'exchanged',
              'overlay-sse',
              'helper-replied',
              'hmr',
              'authenticated-screens',
              'two-port-denied',
              'anonymous-denied',
              'revoked',
              'denied-screens',
            ].includes(message.checkpoint),
          );
          console.log(`Live browser proof checkpoint: ${message.checkpoint}`);
          return;
        }
        if (message.command === 'hmr') {
          const file = join(project, 'src/App.tsx');
          const source = await readFile(file, 'utf8');
          assert.ok(source.includes('Vite 8 + TS Fixture'));
          await writeFile(file, source.replace('Vite 8 + TS Fixture', 'Remote HMR verified'));
        } else if (message.command === 'helper-reply') {
          const event = JSON.parse(
            (await engineRun(['live-poll', '--types=generate', '--timeout=15000'])).trim(),
          );
          assert.equal(event.type, 'generate');
          assert.ok(event.id);
          await engineRun([
            'live-poll',
            '--reply',
            event.id,
            'error',
            'Disposable transport proof; no model requested',
          ]);
        } else if (message.command === 'cross-port-evidence') {
          browser.stdin.write(
            `${JSON.stringify({ ok: true, observations: crossPortObservations })}\n`,
          );
          return;
        } else if (message.command === 'revoke') {
          assert.ok(audiences.get(instance.relayId));
          await connections.revoke({ liveId: instance.liveId });
          assert.equal(connections.size, 0);
        } else if (message.result) {
          browserResult = message.result;
          return;
        } else throw new Error('Unrecognized proof command');
        browser.stdin.write(`${JSON.stringify({ ok: true })}\n`);
      })
      .catch(() => {
        browser.stdin.write('{"ok":false}\n');
      });
  });
  const exit = await new Promise((done) => browser.once('exit', (code) => done(code)));
  await processing;
  await writeFile(
    join(evidence, 'cross-port-gateway-observations.json'),
    JSON.stringify(crossPortObservations, null, 2),
  );
  await writeFile(
    join(evidence, 'browser-upgrade-observations.json'),
    JSON.stringify(upgradeObservations, null, 2),
  );
  assert.equal(exit, 0, `Browser proof failed: ${browserFailure}`);
  assert.ok(browserResult);
  await writeFile(
    join(evidence, 'remote-proof.json'),
    JSON.stringify(
      {
        ...browserResult,
        actualProjectDenial,
        secondProjectDenial,
        runtimeArchiveSha256: '65e619d4126e3d3fd10fc5bb7a43d332fe327dbc38e0085883d920a2ba752898',
        engineSha256: '81fe24a7430571de1003f34fecf787bdc0acefa1be80525ccea9d4b74b5441a0',
        fixture: 'published-source/tests/framework-fixtures/vite8-react-ts',
        actualHelperAndViteManagedPolicy: true,
        controllerPrivate: true,
      },
      null,
      2,
    ),
  );
  await broker.execute(credential, { action: 'remove', appRoot: project });
  await broker.execute(credential, { action: 'remove', appRoot: secondProject });
  console.log(
    'Trusted TLS / separate network / real passkey launch / published helper SSE / Vite HMR / revocation proof passed',
  );
} finally {
  for (const close of cleanup.reverse()) {
    try {
      await close();
    } catch {
      /* Preserve original failure while removing owned resources. */
    }
  }
  await rm(root, { recursive: true, force: true });
}
