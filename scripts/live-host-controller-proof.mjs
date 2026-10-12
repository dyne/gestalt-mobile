/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Hosted diagnostic only. No model calls, runtime credentials, production config or IPC repair.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const evidence = resolve(
  process.env.LIVE_HOST_EVIDENCE_DIR ?? 'test-results/host-controller-proof',
);
mkdirSync(evidence, { recursive: true });
const codex = resolve(process.env.LIVE_HOST_CODEX_BINARY);
const expectedHash = '9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c';
const sourcePin = '979011409de0a60b52f179721948e65531d26144';
const profile = 'l8-host-proof';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const runner = {
  repository: process.env.GITHUB_REPOSITORY,
  runId: process.env.GITHUB_RUN_ID,
};
const root = mkdtempSync(join(tmpdir(), 'live-host-proof-'));
const app = join(root, 'app'),
  privateRoot = join(root, 'private'),
  nativeHome = join(root, 'native-home');
const bin = join(root, 'bin'),
  scratch = join(root, 'scratch');
for (const p of [app, privateRoot, nativeHome, bin, scratch]) mkdirSync(p, { mode: 0o700 });
const publicFile = join(app, 'public.txt');
writeFileSync(publicFile, 'public-fixture');
const privateFiles = ['controller', 'auth', 'caddy'].map((kind) => {
  const path = join(privateRoot, `${kind}.fixture`);
  writeFileSync(path, `${kind}-fixture`, { mode: 0o600 });
  return path;
});
const socketPath = join(privateRoot, 'caddy.fixture.sock');
const daemonDirectory = `/tmp/codex-daemon-${process.geteuid()}`;
const hash = (data) => createHash('sha256').update(data).digest('hex');
const metadata = (path) => {
  try {
    const stat = lstatSync(path);
    return {
      path,
      uid: stat.uid,
      gid: stat.gid,
      mode: (stat.mode & 0o777).toString(8),
      directory: stat.isDirectory(),
      socket: stat.isSocket(),
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error) {
    return { path, errno: error.code };
  }
};
const receipt = (pid) => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const status = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n');
  const field = (key) =>
    status
      .find((line) => line.startsWith(`${key}:`))
      ?.split(':')[1]
      ?.trim();
  return {
    pid,
    startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    uid: field('Uid'),
    gid: field('Gid'),
    namespacePids: field('NSpid'),
    namespaces: Object.fromEntries(
      ['mnt', 'user', 'pid'].map((kind) => [kind, readlinkSync(`/proc/${pid}/ns/${kind}`)]),
    ),
    executable: readlinkSync(`/proc/${pid}/exe`),
    executableSha256: hash(readFileSync(`/proc/${pid}/exe`)),
  };
};
const config = `approval_policy = "never"
default_permissions = "${profile}"
mcp_servers = {}
plugins = {}

[features]
daemon_auto_start = false
multi_agent = false
multi_agent_v2 = false
hooks = false

[permissions.${profile}]
extends = ":workspace"
description = "Isolated host-controller proof with private state denied"

[permissions.${profile}.filesystem]
":root" = "read"
${JSON.stringify(app)} = "write"
${JSON.stringify(scratch)} = "write"
${JSON.stringify(privateRoot)} = "deny"
${JSON.stringify(nativeHome)} = "deny"

[permissions.${profile}.network]
enabled = true
mode = "full"
allow_local_binding = true
`;
writeFileSync(join(nativeHome, 'config.toml'), config, { mode: 0o600 });
symlinkSync(codex, join(bin, 'codex'));
// Credential-free subprocess environment. Do not transmit runner tokens or model credentials.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
  PATH: `${bin}:/usr/bin:/bin`,
  HOME: nativeHome,
  CODEX_HOME: nativeHome,
  XDG_CONFIG_HOME: join(nativeHome, 'xdg'),
  TMPDIR: scratch,
  LANG: 'C.UTF-8',
});

const facts = {
  version: 1,
  commit,
  runner,
  sourcePin,
  profile,
  profileConfigSha256: hash(config),
  controller: receipt(process.pid),
  binary: codex,
  binarySha256: hash(readFileSync(codex)),
  hostDaemonBefore: metadata(daemonDirectory),
  checks: {},
  stage: 'preflight',
  pass: false,
  limitations: [
    'No model calls or credentials: native model file tools untested.',
    'No configured MCP: production MCP/config allowlisting and confinement untested.',
    'No real Live picker/edit/accept or production admission: this cannot accept L8.',
    'Private stdio runtime has no named daemon RPC listener; daemon directory traversal and process/FD aliases are tested.',
  ],
};
let appServer;
let accepted = 0;
const server = createServer((peer) => {
  accepted++;
  peer.end();
});
const controllerSocket = async () => {
  const acceptedEvent = new Promise((done) => server.once('connection', done));
  const connected = new Promise((resolveResult, reject) => {
    const peer = createConnection(socketPath);
    peer.once('connect', () => {
      peer.destroy();
      resolveResult();
    });
    peer.once('error', reject);
  });
  await Promise.all([acceptedEvent, connected]);
};
const safeDiagnostic = (text) =>
  String(text ?? '')
    .split('\n')
    .filter((line) =>
      /app-server socket directory|error building bubblewrap|invalid permission profile|unknown variant|unknown field|invalid request|method not found/i.test(
        line,
      ),
    )
    .slice(0, 2)
    .map((line) => line.slice(0, 300));
const request = async (method, params) => {
  let timer;
  try {
    return await Promise.race([
      appServer.rpc.request(method, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC_TIMEOUT')), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const command = (argv, cap = 24576) =>
  request('command/exec', {
    command: argv,
    cwd: app,
    permissionProfile: profile,
    timeoutMs: 12000,
    outputBytesCap: cap,
  });
const childProbe = async function (input) {
  const fs = await import('node:fs');
  const net = await import('node:net');
  const denyErrors = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);
  const readDenied = (path) => {
    try {
      fs.readFileSync(path);
      return { denied: false };
    } catch (error) {
      return { denied: denyErrors.has(error.code), errno: error.code };
    }
  };
  const connectDenied = (path) =>
    new Promise((done) => {
      let finished = false;
      const peer = net.createConnection(path);
      const finish = (value) => {
        if (finished) return;
        finished = true;
        peer.destroy();
        done(value);
      };
      peer.once('connect', () => finish({ denied: false }));
      peer.once('error', (error) =>
        finish({
          denied: denyErrors.has(error.code) || error.code === 'ECONNREFUSED',
          errno: error.code,
        }),
      );
      peer.setTimeout(300, () => finish({ denied: false, errno: 'TIMEOUT' }));
    });
  const meta = (path) => {
    try {
      const s = fs.lstatSync(path);
      return {
        uid: s.st_uid ?? s.uid,
        gid: s.st_gid ?? s.gid,
        mode: (s.mode & 0o777).toString(8),
        directory: s.isDirectory(),
        device: s.dev,
        inode: s.ino,
      };
    } catch (e) {
      return { errno: e.code };
    }
  };
  const directories = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  if (directories.length > 512) throw new Error('PROC_OBSERVATION_UNBOUNDED');
  const aliases = [...new Set([...directories, ...input.hostPids.map(String)])];
  const privateReads = input.privateFiles.map((path) => ({
    path,
    ...readDenied(path),
  }));
  const privateSocket = await connectDenied(input.socketPath);
  const procReads = [];
  const procSockets = [];
  for (const pid of aliases) {
    for (const path of input.privateFiles)
      procReads.push({ pid, ...readDenied(`/proc/${pid}/root${path}`) });
    procSockets.push({
      pid,
      ...(await connectDenied(`/proc/${pid}/root${input.socketPath}`)),
    });
  }
  const hostFdAliases = input.hostPids.flatMap((pid) =>
    [0, 1, 2].map((fd) => {
      try {
        const opened = fs.openSync(
          `/proc/${pid}/fd/${fd}`,
          fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
        );
        fs.closeSync(opened);
        return { pid, fd, denied: false };
      } catch (error) {
        return {
          pid,
          fd,
          denied: denyErrors.has(error.code),
          errno: error.code,
        };
      }
    }),
  );
  let daemonTraversal;
  try {
    fs.readdirSync(input.daemonDirectory);
    daemonTraversal = { denied: false };
  } catch (error) {
    daemonTraversal = { denied: denyErrors.has(error.code), errno: error.code };
  }
  const daemonAliases = aliases.map((pid) => {
    try {
      fs.readdirSync(`/proc/${pid}/root${input.daemonDirectory}`);
      return { pid, denied: false };
    } catch (error) {
      return { pid, denied: denyErrors.has(error.code), errno: error.code };
    }
  });
  const mounts = fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '))
    .filter((p) => p[4] === input.daemonDirectory || p[4] === input.privateRoot)
    .map((p) => {
      const i = p.indexOf('-');
      return {
        device: p[2],
        mountPoint: p[4],
        flags: p[5],
        filesystem: p[i + 1],
        superOptions: p[i + 3],
      };
    });
  const result = {
    started: true,
    uid: process.geteuid(),
    gid: process.getegid(),
    namespaces: Object.fromEntries(
      ['mnt', 'user', 'pid'].map((kind) => [kind, fs.readlinkSync(`/proc/self/ns/${kind}`)]),
    ),
    publicRead: fs.readFileSync(input.publicFile, 'utf8') === 'public-fixture',
    daemonDirectory: meta(input.daemonDirectory),
    daemonTraversal,
    daemonAliases,
    privateReads,
    privateSocket,
    procReads,
    procSockets,
    hostFdAliases,
    mounts,
  };
  result.pass =
    result.publicRead &&
    privateReads.every((p) => p.denied) &&
    privateSocket.denied &&
    procReads.every((p) => p.denied) &&
    procSockets.every((p) => p.denied) &&
    hostFdAliases.every((p) => p.denied) &&
    daemonTraversal.denied &&
    daemonAliases.every((p) => p.denied) &&
    result.daemonDirectory.mode === '0' &&
    result.daemonDirectory.uid === process.geteuid();
  console.log(JSON.stringify(result));
  process.exitCode = result.pass ? 0 : 1;
};
try {
  if (
    facts.hostDaemonBefore.errno !== 'ENOENT' &&
    (!facts.hostDaemonBefore.directory ||
      facts.hostDaemonBefore.mode !== '700' ||
      facts.hostDaemonBefore.uid !== process.geteuid())
  )
    throw new Error('HOST_BOUNDARY_UNAVAILABLE');
  if (facts.binarySha256 !== expectedHash) throw new Error('BINARY_CHECKSUM_MISMATCH');
  facts.codexVersion = execFileSync(codex, ['--version'], {
    encoding: 'utf8',
  }).trim();
  if (facts.codexVersion !== 'codex-cli 0.161.0') throw new Error('NATIVE_VERSION_MISMATCH');
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(socketPath, done);
  });
  await controllerSocket();
  accepted = 0;
  facts.checks.controllerSocketBefore = true;
  // Use the actual Mobile launcher/stdio client, with the resolved pinned binary on trusted PATH.
  const { launchCodexAppServer } = await import(
    pathToFileURL(resolve('dist/server/server/platform/codex/codex-process-launcher.js')).href
  );
  appServer = launchCodexAppServer({ profile: 'default', cwd: app });
  appServer.child.stderr.on('data', () => {}); // Never retain arbitrary runtime diagnostic content.
  await request('initialize', {
    clientInfo: { name: 'l8_host_controller_proof', version: '1' },
    capabilities: { experimentalApi: true },
  });
  appServer.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  facts.appServer = receipt(appServer.child.pid);
  if (facts.appServer.executableSha256 !== expectedHash) throw new Error('LAUNCH_BINARY_MISMATCH');
  facts.checks.hostRuntime = facts.appServer.namespaces.mnt === facts.controller.namespaces.mnt;
  const profiles = await request('permissionProfile/list', { cwd: app });
  facts.checks.namedProfileAllowed =
    profiles.data?.some((p) => p.id === profile && p.allowed === true) === true;
  if (!facts.checks.namedProfileAllowed) throw new Error('NAMED_PROFILE_NOT_ALLOWED');
  const configured = await request('config/read', {
    cwd: app,
    includeLayers: false,
  });
  facts.configuredMcpCount = Object.keys(configured.config?.mcp_servers ?? {}).length;
  facts.configuredPluginCount = Object.keys(configured.config?.plugins ?? {}).length;
  if (facts.configuredMcpCount || facts.configuredPluginCount)
    throw new Error('UNEXPECTED_MCP_CONFIG');
  facts.stage = 'trusted-fs-rpc';
  const trustedRead = await request('fs/readFile', { path: privateFiles[0] });
  facts.checks.trustedFsRpcHostAuthority =
    trustedRead.dataBase64 === Buffer.from('controller-fixture').toString('base64');
  facts.stage = 'native-command';
  const ordinary = await command(['/usr/bin/true'], 1024);
  facts.ordinaryExitCode = ordinary.exitCode;
  facts.ordinaryDiagnostic = safeDiagnostic(ordinary.stderr);
  facts.checks.ordinaryCommand = ordinary.exitCode === 0;
  if (!facts.checks.ordinaryCommand) throw new Error('ORDINARY_NATIVE_COMMAND_FAILED');
  facts.hostDaemonAfterCommand = metadata(daemonDirectory);
  const input = {
    publicFile,
    privateFiles,
    privateRoot,
    socketPath,
    daemonDirectory,
    hostPids: [process.pid, appServer.child.pid],
  };
  const confined = await command([
    process.execPath,
    '--input-type=module',
    '--eval',
    `await (${childProbe.toString()})(${JSON.stringify(input)});`,
  ]);
  facts.confinedExitCode = confined.exitCode;
  facts.confinedDiagnostic = safeDiagnostic(confined.stderr);
  try {
    facts.sandboxedChild = JSON.parse(confined.stdout);
  } catch {
    throw new Error('CHILD_PROOF_UNAVAILABLE');
  }
  facts.checks.nativeChildConfinement =
    confined.exitCode === 0 && facts.sandboxedChild.pass === true;
  facts.checks.sameUid = facts.sandboxedChild.uid === Number(facts.controller.uid.split(/\s+/)[0]);
  facts.checks.fixtureSocketNotReached = accepted === 0;
  await controllerSocket();
  facts.checks.controllerSocketAfter = true;
  facts.hostDaemonAfter = metadata(daemonDirectory);
  facts.pass = Object.values(facts.checks).every((value) => value === true);
  facts.stage = 'complete';
} catch (error) {
  facts.failure = /^[A-Z_]+$/.test(error.message) ? error.message : 'PROOF_OPERATION_FAILED';
  facts.rpcErrorCode = typeof error.code === 'number' ? error.code : null;
  facts.safeDiagnostic = safeDiagnostic(error.message);
  process.exitCode = 1;
} finally {
  if (appServer) {
    const gone = new Promise((done) => appServer.child.once('close', done));
    appServer.close();
    await Promise.race([gone, new Promise((done) => setTimeout(done, 3000))]);
    if (appServer.child.exitCode === null && appServer.child.signalCode === null) {
      appServer.child.kill('SIGKILL');
      await gone;
    }
    facts.ownedAppServerStopped =
      appServer.child.exitCode !== null || appServer.child.signalCode !== null;
  }
  if (server.listening) await new Promise((done) => server.close(done));
  facts.observedAt = new Date().toISOString();
  facts.pass = facts.pass && facts.ownedAppServerStopped === true;
  writeFileSync(join(evidence, 'host-controller-proof.json'), JSON.stringify(facts, null, 2));
  rmSync(root, { recursive: true, force: true }); // Only this owned temporary fixture.
  if (!facts.pass) process.exitCode = 1;
  console.log(
    JSON.stringify({
      pass: facts.pass,
      stage: facts.stage,
      failure: facts.failure,
      artifact: join(evidence, 'host-controller-proof.json'),
    }),
  );
}
