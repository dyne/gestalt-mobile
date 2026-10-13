/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Actual namespace/native process proof on a disposable supported host; no provider claim.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import { createConnection, createServer as unixServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { IsolatedProjectProcess } from '../dist/server/server/platform/live-design/isolated-project-process.js';
import { LIVE_HELPER_BINARY_SHA256 } from '../dist/server/server/platform/live-design/helper-process.js';
import {
  LIVE_CODEX_SHA256,
  LIVE_CODEX_BWRAP_SHA256,
} from '../dist/server/server/platform/live-design/native-contract.js';

assert.equal(process.env.LIVE_PROJECT_ISOLATION_PROOF, '1');
const evidence = resolve(
  process.env.LIVE_PROJECT_ISOLATION_EVIDENCE ?? 'test-results/live-caddy-proof/project-isolation',
);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'l11-project-isolation-'));
const app = join(root, 'app');
const controller = join(root, 'controller');
const outside = join(root, 'outside');
for (const path of [app, controller, outside]) mkdirSync(path, { mode: 0o700 });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = (path) => ({ path: realpathSync(path), sha256: hash(readFileSync(path)) });
const native = pin(process.env.LIVE_HOST_CODEX_BINARY);
const bwrap = pin(join(dirname(dirname(native.path)), 'codex-resources/bwrap'));
const node = pin(process.execPath);
const worker = pin(resolve('dist/server/server/platform/live-design/project-process-worker.js'));
const impeccable = pin(process.env.LIVE_TEST_IMPECCABLE);
assert.equal(native.sha256, LIVE_CODEX_SHA256);
assert.equal(bwrap.sha256, LIVE_CODEX_BWRAP_SHA256);
assert.equal(impeccable.sha256, LIVE_HELPER_BINARY_SHA256);
const canary = randomBytes(32).toString('hex');
const credential = join(controller, 'canary');
writeFileSync(credential, canary, { mode: 0o600 });
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ name: 'isolated-live-fixture', type: 'module' }),
  { mode: 0o600 },
);
const adminPath = join(outside, 'admin.sock');
assert.ok(Buffer.byteLength(adminPath) < 104);
let adminConnections = 0;
const admin = unixServer((peer) => {
  adminConnections++;
  peer.end();
});
const hostServer = createServer((_req, res) => res.end('host-only'));
const report = {
  schemaVersion: 1,
  passed: false,
  stage: 'initialization',
  genuine: false,
  checks: {},
  provenance: {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    native: native.sha256,
    bwrap: bwrap.sha256,
    worker: worker.sha256,
    helper: impeccable.sha256,
  },
};
const processes = [];
async function http(process, receipt, path) {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => process.open(receipt);
  try {
    return await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: 1, path, agent, signal: AbortSignal.timeout(10000) },
        (res) => {
          const chunks = [];
          let length = 0;
          res.on('data', (chunk) => {
            length += chunk.length;
            if (length > 65536) req.destroy(new Error('RESPONSE_BOUND'));
            else chunks.push(chunk);
          });
          res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
          res.once('error', reject);
        },
      );
      req.once('error', reject);
      req.end();
    });
  } finally {
    agent.destroy();
  }
}
function specification(role, executable, argv, protectedPaths, launchInputs = []) {
  return {
    role,
    sessionId: 'isolation-owning-session',
    generation: 1,
    appRoot: app,
    privateDirectory: controller,
    native,
    bwrap,
    node,
    worker,
    executable,
    argv,
    environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
    launchInputs,
    protectedPaths,
    filesystem: {
      type: 'restricted',
      entries: [
        { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
        { path: { type: 'path', path: app }, access: 'write' },
        ...[controller, ...protectedPaths, '/proc'].map((path) => ({
          path: { type: 'path', path },
          access: 'deny',
        })),
      ],
    },
    port: role === 'helper' ? 12181 : 12182,
  };
}
try {
  assert.equal(report.provenance.head, process.env.LIVE_PROOF_EXPECTED_HEAD);
  await new Promise((done, reject) => {
    admin.once('error', reject);
    admin.listen(adminPath, done);
  });
  await new Promise((done, reject) => {
    const peer = createConnection(adminPath);
    peer.once('error', reject);
    peer.once('end', done);
    peer.resume();
  });
  await new Promise((done, reject) => {
    hostServer.once('error', reject);
    hostServer.listen(0, '127.0.0.1', done);
  });
  const hostPort = hostServer.address().port;
  report.stage = 'actual-pinned-helper-isolation';
  const helper = new IsolatedProjectProcess(
    specification('helper', impeccable, ['live-server', '--port=12181', '--target', app], []),
  );
  processes.push(helper);
  const helperReceipt = await helper.start();
  assert.equal((await http(helper, helperReceipt, '/health')).status, 200);
  const metadata = JSON.parse(readFileSync(join(app, '.impeccable/live/server.json'), 'utf8'));
  assert.equal(typeof metadata.token, 'string');
  const source = join(app, 'isolated-devserver.mjs');
  // Token intentionally known to adversarial project code: endpoint isolation must still hold.
  const code = `import {createServer,request} from 'node:http'; import {createConnection} from 'node:net'; import {readFileSync} from 'node:fs'; import {spawn,spawnSync} from 'node:child_process';
const checks={}; const denied=p=>{try{readFileSync(p);return false}catch(e){return ['ENOENT','EACCES','EPERM','ENOTDIR'].includes(e.code)}};
checks.privateReadDenied=denied(${JSON.stringify(credential)});checks.helperStateDenied=denied(${JSON.stringify(join(app, '.impeccable/live/server.json'))});checks.procAliasDenied=denied(${JSON.stringify('/proc/' + process.pid + '/root' + credential)});
checks.knownTokenCannotPoll=await new Promise(done=>{const q=request({host:'127.0.0.1',port:12181,path:'/poll?token='+${JSON.stringify(metadata.token)},timeout:1500},r=>{r.destroy();done(false)});q.once('error',e=>done(['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(e.code)));q.once('timeout',()=>{q.destroy();done(false)});q.end()});
checks.hostLoopbackDenied=await new Promise(done=>{const q=request({host:'127.0.0.1',port:${hostPort},timeout:1500},r=>{r.destroy();done(false)});q.once('error',e=>done(['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(e.code)));q.once('timeout',()=>{q.destroy();done(false)});q.end()});
checks.visibleHostUnixDenied=await new Promise(done=>{try{const p=createConnection(${JSON.stringify(adminPath)});p.once('connect',()=>{p.destroy();done(false)});p.once('error',e=>done(e.code==='EPERM'||e.code==='EACCES'));}catch(e){done(e.code==='EPERM'||e.code==='EACCES')}});
const child=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(`import {readFileSync} from 'node:fs'; try {readFileSync(${JSON.stringify(credential)});process.exit(7)} catch(e) {process.exit(['ENOENT','EACCES','EPERM','ENOTDIR'].includes(e.code)?0:9)}`)}],{stdio:'ignore'});checks.childPrivateReadDenied=child.status===0;
spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
createServer((q,r)=>{if(q.url==='/crash')process.exit(0);r.setHeader('content-type','application/json');r.end(JSON.stringify(checks))}).listen(12182,'127.0.0.1');`;
  writeFileSync(source, code, { mode: 0o600 });
  report.stage = 'actual-devserver-isolation';
  const devserver = new IsolatedProjectProcess(
    specification('devserver', node, [source], [join(app, '.impeccable')], [pin(source)]),
  );
  processes.push(devserver);
  const devReceipt = await devserver.start();
  assert.notEqual(devReceipt.target.namespaces.net, helperReceipt.target.namespaces.net);
  const observed = await http(devserver, devReceipt, '/');
  assert.equal(observed.status, 200);
  const checks = JSON.parse(observed.body);
  assert.ok(Object.values(checks).every((value) => value === true));
  assert.equal(adminConnections, 1);
  assert.equal(readFileSync(credential, 'utf8'), canary);
  report.checks.separateNamespaces = true;
  report.checks.nativeFilesystemAndHostUnixDenials = true;
  report.checks.knownBrowserTokenCannotCompeteForPoll = true;
  report.checks.fixedPipeHttpRelay = true;
  report.stage = 'tampered-launch-input';
  writeFileSync(source, code + '\n// tampered launch input\n');
  assert.throws(() => devserver.verify(devReceipt));
  writeFileSync(source, code, { mode: 0o600 });
  report.checks.changedLaunchInputRefused = true;
  report.stage = 'revoke-devserver-first';
  await new Promise((done) => setTimeout(done, 9000));
  await devserver.stop();
  assert.throws(() => devserver.open(devReceipt));
  assert.equal((await http(helper, helperReceipt, '/health')).status, 200);
  report.checks.staleReceiptRevokedHelperSurvives = true;
  report.stage = 'stop-helper';
  await helper.stop();
  assert.throws(() => helper.open(helperReceipt));
  report.checks.ownedNamespacesAndDescendantsExited = true;
  report.passed = true;
  report.stage = 'complete';
} catch {
  report.resourceDiagnostics = processes.map((owned) => owned.diagnostics());
  process.exitCode = 1;
} finally {
  let cleanup = true;
  for (const process of processes.reverse()) {
    try {
      await process.stop();
    } catch {
      cleanup = false;
    }
  }
  hostServer.closeAllConnections();
  await new Promise((done) => hostServer.close(done));
  await new Promise((done) => admin.close(done));
  report.cleanupComplete = cleanup;
  writeFileSync(
    join(evidence, 'project-isolation-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      stage: report.stage,
      cleanupComplete: cleanup,
      genuine: false,
    }) + '\n',
  );
  if (cleanup) rmSync(root, { recursive: true, force: true });
}
