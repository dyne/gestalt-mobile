/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Supported-host production construction and real native tools. The provider is
// controlled and credential-free; this never substitutes for genuine proof.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as portServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { removeOwnedProofTree } from './live-proof-cleanup.mjs';
import { projectMetadataRegistryDiagnostics } from './live-project-metadata-diagnostics.mjs';
import {
  observeProofMethod,
  observeInstalledPolicyTimings,
  observeAdmissionTimings,
  cleanupControllerSnapshot,
} from './live-production-edit-diagnostics.mjs';
import { LivePollLoop } from '../dist/server/server/features/live-design/application/poll-loop.js';
import { PollLiveEvents } from '../dist/server/server/features/live-design/application/poll-events.js';
import { IsolatedLiveHelper } from '../dist/server/server/platform/live-design/isolated-live-helper.js';
import { CodexSessionRuntime } from '../dist/server/server/platform/codex/session-runtime.js';
import {
  createProductionEditProvider,
  liveEventFromRequest,
} from './live-production-edit-provider.mjs';
import { productionEditBrowser } from './live-production-edit-browser-host.mjs';
import { productionRecoveryProof } from './live-production-recovery-proof.mjs';
import {
  candidateIdentity,
  openRecoveryHandoff,
  birthCurrent,
  productionLane,
} from './live-production-proof-lanes.mjs';
import {
  NativeContextCompletion,
  contextToolResultDiagnostic,
  pickerSmokeBaseline,
} from './live-picker-smoke.mjs';
import { composeRelayApp } from '../dist/server/server/composition.js';
import { SqliteAuthorizationStore } from '../dist/server/server/platform/auth/sqlite-authorization-store.js';
import { workspaceId } from '../dist/server/server/platform/catalog/workspace-id.js';
import {
  measureInstalledLiveTree,
  LIVE_MANAGER_SHA256,
  InstalledLivePolicy,
  InstalledLiveAdmissionError,
} from '../dist/server/server/platform/live-design/installed-policy.js';
import { ProductionLiveController } from '../dist/server/server/platform/live-design/production-controller.js';
import { LiveDispatchGuard } from '../dist/server/server/platform/live-design/live-dispatch.js';
import {
  LIVE_CODEX_SHA256,
  LIVE_CODEX_BWRAP_SHA256,
} from '../dist/server/server/platform/live-design/native-contract.js';
import { LIVE_HELPER_BINARY_SHA256 } from '../dist/server/server/platform/live-design/helper-process.js';
import { observedBirthExited } from '../dist/server/server/platform/live-design/process-identity.js';
import { previewSecrets } from '../dist/server/server/platform/live-design/preview-secrets.js';
import { IsolatedProjectProcess } from '../dist/server/server/platform/live-design/isolated-project-process.js';
import {
  LIVE_MANAGER_OBSERVATION_MS,
  installedMcpBudgets,
} from '../dist/server/server/platform/live-design/installed-launch-contract.js';
import {
  helperEventIdDigest,
  helperProtocolSummary,
} from './live-production-helper-diagnostics.mjs';

assert.equal(process.env.LIVE_PRODUCTION_ENTRYPOINT_PROOF, '1');
const editFlow = process.env.LIVE_PRODUCTION_EDIT_FLOW_PROOF === '1';
const preflightOnly = process.env.LIVE_PRODUCTION_ADMISSION_PREFLIGHT === '1';
const pickerSmoke = process.env.LIVE_PRODUCTION_PICKER_SMOKE === '1';
const pickerDiagnostic = process.env.LIVE_PRODUCTION_PICKER_DIAGNOSTIC === '1';
assert.ok(!pickerDiagnostic || pickerSmoke);
assert.ok(!pickerSmoke || (editFlow && !preflightOnly));
const seededPreflight = process.env.LIVE_PRODUCTION_ADMISSION_SEED === '1';
assert.ok(!seededPreflight || preflightOnly);
// Four serial measured control stages, the accepted Native context probe,
// two existing project-readiness windows and a bounded response allowance.
const startObservationBudgetMs =
  4 * (LIVE_MANAGER_OBSERVATION_MS + 5_000) +
  installedMcpBudgets('context-mode', true).tool_timeout_sec * 1000 +
  5_000 +
  2 * 15_000 +
  5_000;
assert.equal(startObservationBudgetMs, 815_000);
// Two measured authority windows, two existing helper-command windows and
// bounded result delivery; the upstream595s lease is never extended.
const eventObservationBudgetMs = 2 * (LIVE_MANAGER_OBSERVATION_MS + 30_000) + 2 * 20_000 + 20_000;
assert.equal(eventObservationBudgetMs, 300_000);
assert.ok(!preflightOnly || !editFlow);
const recoveryOnly = process.env.LIVE_PRODUCTION_RECOVERY_ONLY === '1';
assert.ok(!(editFlow && recoveryOnly));
const proofLane = productionLane(process.env.LIVE_PRODUCTION_PROOF_LANE);
assert.ok(!proofLane || (!pickerSmoke && !preflightOnly));
assert.ok(!proofLane || (proofLane === 'recovery' ? recoveryOnly : editFlow));
assert.equal(Boolean(process.env.LIVE_PRODUCTION_RECOVERY_CHANNEL), proofLane === 'recovery');
const evidence = resolve(
  process.env.LIVE_PRODUCTION_EVIDENCE ?? 'test-results/live-caddy-proof/production-entrypoint',
);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const report = {
  schemaVersion: 1,
  productionLane: proofLane || undefined,
  passed: false,
  genuine: false,
  stage: 'installation',
  checks: {},
  provider: { requestCount: 0 },
  cleanupComplete: false,
  limitations: [
    'Controlled provider, not genuine credential-dependent proof.',
    'Explicit already-hook-free installed bridge fixture; unchanged ordinary hooked homes and enabled Gestalt metadata remain unsupported.',
    ...(editFlow
      ? [
          'Browser uses a temporary pre-provisioned authorized device; WebAuthn enrollment is separately proven.',
        ]
      : [
          'Admission/model-tool probe does not claim a successful generated UI variant or acceptance.',
        ]),
  ],
};
if (pickerDiagnostic) {
  report.proofKind = 'actual-picker-current-independent-diagnostic';
  report.pickerDiagnostic = {
    mode: 'picker-diagnostic',
    diagnosticOnly: true,
    fullExactCandidateStillRequired: true,
    identity: candidateIdentity(),
  };
  report.limitations.push(
    'Diagnostic Start/Generate/Accept only; fresh independent evidence on this exact candidate is mandatory in the aggregate. Steer/manual/discard/background/recovery remain unproven.',
  );
} else if (pickerSmoke) {
  const receipt = JSON.parse(readFileSync(process.env.LIVE_PICKER_SMOKE_RECEIPT, 'utf8'));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.mode, 'picker-smoke');
  assert.equal(receipt.diagnosticOnly, true);
  assert.equal(receipt.fullExactCandidateStillRequired, true);
  assert.equal(receipt.candidate, process.env.LIVE_PROOF_EXPECTED_HEAD);
  assert.deepEqual(receipt.baseline, pickerSmokeBaseline);
  report.proofKind = 'actual-picker-smoke-diagnostic';
  report.independentEvidenceReuse = receipt;
  report.limitations.push(
    'Diagnostic controls Start/Generate/Accept/cleanup only; full exact-candidate independent, steer/manual/discard/background/recovery proofs remain required.',
  );
}
if (recoveryOnly) {
  report.proofKind = 'recovery-only-diagnostic-no-picker-or-model-child-claim';
  report.limitations.push(
    'Renewal diagnostic only; full real-picker and owning model-child proof remains mandatory.',
  );
}
if (proofLane) report.proofKind = `controlled-full-${proofLane}`;
const admissionFailure = (error) => ({
  code: /^LIVE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'UNCLASSIFIED',
  reason: error instanceof InstalledLiveAdmissionError ? error.diagnostic.reason : undefined,
});
function renewalManifestRelation(input) {
  try {
    const parse = (path) => {
      const bytes = readFileSync(path);
      assert.ok(bytes.length <= 2 * 1024 * 1024);
      return JSON.parse(bytes);
    };
    const previous = parse(input.previousManifestPath),
      next = parse(input.manifestPath);
    const stable = (value) =>
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      );
    const same = (a, b) => stable(a) === stable(b);
    const original = previous.configFiles.filter(
      (file) =>
        file.path !== join(previous.runtimeHome, 'config.toml') ||
        previous.runtimeHome === previous.owningRuntime.home,
    );
    return {
      equality: Object.fromEntries(
        [
          'schemaVersion',
          'components',
          'election',
          'owningRuntime',
          'privatePaths',
          'binary',
          'keyFile',
          'sandboxState',
        ].map((field) => [field, same(previous[field], next[field])]),
      ),
      originalConfigPinsIncluded: original.every((file) =>
        next.configFiles.some((current) => same(file, current)),
      ),
      generationIncreased: next.generation.generation > previous.generation.generation,
      sameSession: next.generation.sessionId === previous.generation.sessionId,
      workerHomeChanged: previous.runtimeHome !== next.runtimeHome,
      samePathAndTemporaryEnvironment: ['PATH', 'TMPDIR'].every(
        (key) => previous.environment[key] === next.environment[key],
      ),
    };
  } catch {
    return { unavailable: true };
  }
}
for (const method of ['bootstrapRuntime', 'renewRuntime', 'sealRuntime', 'revokeRuntime']) {
  const original = InstalledLivePolicy.prototype[method];
  InstalledLivePolicy.prototype[method] = async function (...args) {
    const rows = (report.policyProtocol ??= []);
    if (rows.length === 32) rows.shift();
    const row = { operation: method, outcome: 'pending' };
    rows.push(row);
    try {
      const result = await original.apply(this, args);
      row.outcome = 'completed';
      return result;
    } catch (error) {
      Object.assign(row, { outcome: 'refused', ...admissionFailure(error) });
      if (method === 'renewRuntime') row.manifestRelation = renewalManifestRelation(args[0]);
      throw error;
    }
  };
}
const originalPolicyVerify = InstalledLivePolicy.prototype.verify;
InstalledLivePolicy.prototype.verify = async function (...args) {
  try {
    return await originalPolicyVerify.apply(this, args);
  } catch (error) {
    const failures = (report.policyVerificationRefusals ??= []);
    if (failures.length === 32) failures.shift();
    failures.push(admissionFailure(error));
    throw error;
  }
};
const originalOwnerStarted = ProductionLiveController.prototype.observeOwnerStarted;
ProductionLiveController.prototype.observeOwnerStarted = async function (...args) {
  try {
    return await originalOwnerStarted.apply(this, args);
  } catch (error) {
    report.originalAdmissionRefusal = {
      ...admissionFailure(error),
      configurationShape: error?.liveConfigDiagnostics,
      launchInventory: error?.liveLaunchInventory,
      sourceInventory: error?.liveSourceDiagnostics,
    };
    throw error;
  }
};
const originalRenewGeneration = ProductionLiveController.prototype.renewGeneration;
assert.equal(typeof originalRenewGeneration, 'function');
ProductionLiveController.prototype.renewGeneration = async function (...args) {
  try {
    return await originalRenewGeneration.apply(this, args);
  } catch (error) {
    report.originalRenewalFailure = admissionFailure(error);
    throw error;
  }
};
// Observe the actual authority boundary without supplying admission or model output.
const actualLiveEvent = LiveDispatchGuard.prototype.liveEvent;
LiveDispatchGuard.prototype.liveEvent = async function (fence, eventId, work) {
  const began = performance.now();
  const phase = /^[a-f0-9]{8}$/.test(eventId) ? 'event-turn' : 'canonical-poll';
  let grantedAfterMs = null;
  let completed = false;
  try {
    const result = await actualLiveEvent.call(this, fence, eventId, async () => {
      grantedAfterMs = Math.round(performance.now() - began);
      return work();
    });
    completed = true;
    return result;
  } finally {
    const timings = (report.eventAuthorityTimings ??= []);
    if (timings.length === 64) timings.shift();
    timings.push({
      phase,
      grantedAfterMs,
      elapsedMs: Math.round(performance.now() - began),
      completed,
    });
  }
};
// Measure the real controller phases without supplying readiness or changing
// their result. These fixed labels contain no arguments, paths or Native output.
for (const phase of [
  'register',
  'verifyGeneration',
  'prepareOwner',
  'authorize',
  'expose',
  'renewGeneration',
]) {
  const perform = ProductionLiveController.prototype[phase];
  assert.equal(typeof perform, 'function');
  ProductionLiveController.prototype[phase] = async function (...args) {
    const began = performance.now();
    let completed = false;
    try {
      const result = await perform.apply(this, args);
      completed = true;
      return result;
    } finally {
      const timings = (report.startPhaseTimings ??= []);
      if (timings.length === 64) timings.shift();
      timings.push({ phase, elapsedMs: Math.round(performance.now() - began), completed });
    }
  };
}
const browserEventLoop = monitorEventLoopDelay({ resolution: 20 });
function finishBrowserProfile() {
  if (!report.browserCpuWindowStartUs || report.browserCpuWindowEndUs) return;
  report.browserCpuWindowEndUs = Number(process.hrtime.bigint() / 1000n);
  browserEventLoop.disable();
  report.browserEventLoop = {
    maxDelayMs: Math.round(browserEventLoop.max / 1e6),
    p99DelayMs: Math.round(browserEventLoop.percentile(99) / 1e6),
    samples: browserEventLoop.count,
  };
}
// Fixture-only observation: retain the production verifier, inputs and outcome.
// Record timing/codes only, never receipts, process environments or credentials.
const originalNativeLaunch = ProductionLiveController.prototype.launchNative;
ProductionLiveController.prototype.launchNative = function (input) {
  const child = originalNativeLaunch.call(this, input);
  const observation = {
    capturedOwner: !!input.liveCaptureId,
    treeObservations: 0,
    treeFailures: 0,
    requests: [],
    stderrMarkers: [],
  };
  (report.nativeLaunchLifetimes ??= []).push(observation);
  child.child.once('error', (error) => {
    observation.spawnError = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)
      ? error.code
      : 'UNCLASSIFIED';
  });
  child.child.once('exit', (code, signal) => {
    observation.exitCode = code;
    observation.signal = signal;
  });
  child.child.stderr.on('data', (chunk) => {
    for (const marker of [
      'not found',
      'not installed',
      'No such file',
      'Permission denied',
      'Read-only',
      'sandbox',
      'mode',
      'unsupported',
      'usage:',
      'error:',
      'Error:',
      'requires',
    ]) {
      if (String(chunk).includes(marker) && !observation.stderrMarkers.includes(marker))
        observation.stderrMarkers.push(marker);
    }
  });
  const observe = child.observeLiveDescendants.bind(child);
  child.observeLiveDescendants = () => {
    observation.treeObservations++;
    try {
      return observe();
    } catch (error) {
      observation.treeFailures++;
      throw error;
    }
  };
  const close = child.close.bind(child);
  child.close = () => {
    observation.closeWhileAlive = child.child.exitCode === null && child.child.signalCode === null;
    return close();
  };
  const wait = child.waitForExit.bind(child);
  child.waitForExit = async () => {
    try {
      await wait();
      observation.exitVerified = true;
    } catch (error) {
      observation.exitVerified = false;
      observation.exitFailure = /^LIVE_[A-Z_]+$/.test(error?.message ?? '')
        ? error.message
        : 'UNCLASSIFIED';
      throw error;
    }
  };
  const request = child.rpc.request.bind(child.rpc);
  child.rpc.request = async (method, params) => {
    const tracked =
      ['initialize', 'model/list', 'skills/list'].includes(method) &&
      observation.requests.length < 12;
    try {
      const value = await request(method, params);
      if (tracked) observation.requests.push({ method, completed: true });
      if (method === 'config/read') {
        const config = value?.config;
        const descriptor = config?.mcp_servers?.['context-mode'];
        const known = [
          'command',
          'args',
          'env',
          'env_vars',
          'cwd',
          'enabled',
          'required',
          'default_tools_approval_mode',
          'startup_timeout_sec',
          'startup_timeout_ms',
          'tool_timeout_sec',
          'url',
          'http_headers',
          'bearer_token_env_var',
          'enabled_tools',
          'disabled_tools',
          'oauth',
        ];
        const shapes = (report.originalConfigShapes ??= []);
        if (shapes.length === 64) shapes.shift();
        shapes.push({
          context: descriptor
            ? {
                keys: Object.keys(descriptor).map((key) =>
                  known.includes(key) ? key : 'unrecognized',
                ),
                commandIsNode: descriptor.command === 'node',
                argsCount: descriptor.args?.length,
                enabled: descriptor.enabled === true,
                required: descriptor.required === true,
                approve: descriptor.default_tools_approval_mode === 'approve',
                envType: descriptor.env === null ? 'null' : typeof descriptor.env,
                cwdType: descriptor.cwd === null ? 'null' : typeof descriptor.cwd,
              }
            : null,
          plugins: Object.keys(config?.plugins ?? {}).map((name) =>
            ['context-mode@dyne-gestalt-agents', 'gestalt@dyne-gestalt-agents'].includes(name)
              ? name
              : 'unapproved',
          ),
          hooksExplicitlyFalse: config?.features?.hooks === false,
        });
      }
      if (method === 'mcpServerStatus/list' && params?.threadId && params?.serverName) {
        const rows = (observation.owningCatalogs ??= []);
        for (const server of value?.data ?? []) {
          if (rows.length === 64) rows.shift();
          rows.push({
            name: ['context-mode', 'gestalt-org-plan'].includes(server.name)
              ? server.name
              : 'unapproved',
            status: ['connected', 'failed', 'starting', 'notStarted'].includes(server.runtimeStatus)
              ? server.runtimeStatus
              : 'unrecognized',
            toolCount:
              server.tools && typeof server.tools === 'object'
                ? Object.keys(server.tools).length
                : null,
            threadIdDigest: hash(params.threadId),
          });
        }
      }
      return value;
    } catch (error) {
      if (tracked) observation.requests.push({ method, completed: false });
      throw error;
    }
  };
  admissionTimings.observeRpc(child.rpc);
  return child;
};
const projectProcesses = new Map();
const originalHelperCommand = IsolatedProjectProcess.prototype.helperCommand;
IsolatedProjectProcess.prototype.helperCommand = async function (receipt, args, deadline) {
  const result = await originalHelperCommand.call(this, receipt, args, deadline);
  if (['live-status', 'live-resume', 'live-complete'].includes(args[0])) {
    const rows = (report.helperProtocol ??= []);
    if (rows.length === 40) rows.shift();
    rows.push(helperProtocolSummary(args, result));
  }
  return result;
};
const originalProjectVerify = IsolatedProjectProcess.prototype.verify;
IsolatedProjectProcess.prototype.verify = function (receipt) {
  const started = performance.now();
  const metrics = projectProcesses.get(this) ?? {
    role: ['helper', 'devserver'].includes(receipt?.role) ? receipt.role : 'unknown',
    count: 0,
    totalMs: 0,
    maxMs: 0,
    failures: 0,
  };
  projectProcesses.set(this, metrics);
  try {
    return originalProjectVerify.call(this, receipt);
  } catch (error) {
    metrics.failures++;
    throw error;
  } finally {
    const elapsed = Math.round(performance.now() - started);
    metrics.count++;
    metrics.totalMs += elapsed;
    metrics.maxMs = Math.max(metrics.maxMs, elapsed);
    report.projectVerification = [...projectProcesses].map(([owned, value]) => ({
      ...value,
      diagnostics: owned.diagnostics(),
    }));
  }
};
const originalConnectionVerify = IsolatedProjectProcess.prototype.verifyForConnection;
IsolatedProjectProcess.prototype.verifyForConnection = async function (
  receipt,
  cancellation,
  files,
) {
  const started = performance.now();
  try {
    return await originalConnectionVerify.call(this, receipt, cancellation, files);
  } finally {
    const metrics = projectProcesses.get(this);
    if (metrics) {
      const elapsed = Math.round(performance.now() - started);
      metrics.connectionCount = (metrics.connectionCount ?? 0) + 1;
      metrics.connectionTotalMs = (metrics.connectionTotalMs ?? 0) + elapsed;
      metrics.connectionMaxMs = Math.max(metrics.connectionMaxMs ?? 0, elapsed);
      if (files)
        metrics.maxConnectionFileBytes = Math.max(
          metrics.maxConnectionFileBytes ?? 0,
          files.statistics().bytesRead,
        );
      report.projectVerification = [...projectProcesses].map(([owned, value]) => ({
        ...value,
        diagnostics: owned.diagnostics(),
      }));
    }
  }
};
report.policyVerificationTimings = observeInstalledPolicyTimings(InstalledLivePolicy.prototype);
const admissionTimings = observeAdmissionTimings(
  CodexSessionRuntime.prototype,
  ProductionLiveController.prototype,
);
report.admissionVerificationTimings = admissionTimings.report;
const cleanupOperations = (report.cleanupOperations = []);
const lifecycle = (boundary, owner) => {
  const rows = (report.cleanupLifecycle ??= []);
  if (rows.length === 8) rows.shift();
  rows.push({ boundary, ...cleanupControllerSnapshot(owner) });
  report.cleanupProjectClosure = [...projectProcesses].slice(0, 8).map(([process, metrics]) => {
    const proof = process.diagnostics();
    return {
      role: metrics.role,
      namespaceExited: proof.namespaceExited === true,
      pipeDescriptorsClosed: proof.pipeDescriptorsClosed === true,
    };
  });
};
for (const [target, key, operation] of [
  [InstalledLivePolicy.prototype, 'revokeRuntime', 'signed-revoke'],
  [LivePollLoop.prototype, 'drain', 'poll-drain'],
  [PollLiveEvents.prototype, 'settle', 'poll-settle'],
  [IsolatedLiveHelper.prototype, 'settle', 'helper-settle'],
  [IsolatedLiveHelper.prototype, 'removeInjection', 'helper-remove-injection'],
  [IsolatedLiveHelper.prototype, 'forgetExitedServerRecord', 'helper-forget-record'],
  [CodexSessionRuntime.prototype, 'settleLiveWork', 'owning-settle'],
  [CodexSessionRuntime.prototype, 'abortLiveOwner', 'owning-abort'],
])
  observeProofMethod(target, key, operation, cleanupOperations);
observeProofMethod(IsolatedProjectProcess.prototype, 'stop', 'project-stop', cleanupOperations, {
  role: (owner) => projectProcesses.get(owner)?.role,
});
observeProofMethod(
  ProductionLiveController.prototype,
  'close',
  'controller-close',
  cleanupOperations,
  {
    before: (owner) => lifecycle('before-close', owner),
    after: (owner) => lifecycle('after-close', owner),
  },
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = (path) => ({ path: realpathSync(path), sha256: hash(readFileSync(path)) });
const root = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'l11-entry-'));
const rootIdentity = lstatSync(root);
const installationOnly = process.env.LIVE_PRODUCTION_INSTALLATION_ONLY === '1';
if (preflightOnly)
  report.proofKind = seededPreflight
    ? 'installed-bridge-owning-catalog-start-preflight-one-controlled-seed'
    : 'installed-bridge-owning-catalog-start-preflight-no-model-turn';
const constructionOnly = process.env.LIVE_PRODUCTION_CONSTRUCTION_ONLY === '1';
assert.ok(!(installationOnly && constructionOnly));
if (constructionOnly) report.proofKind = 'construction-only-no-native-launch';
if (installationOnly) report.proofKind = 'installation-only-no-native-launch';
const appRoot = join(root, 'app'),
  privateRoot = join(root, 'home/.codex-gestalt/gestalt-mobile'),
  installation = join(root, 'installed');
for (const path of [appRoot, privateRoot, installation])
  mkdirSync(path, { mode: 0o700, recursive: true });
const home = join(root, 'home'),
  owningHome = join(privateRoot, 'owning'),
  controller = join(privateRoot, 'controller'),
  caddyRoot = join(privateRoot, 'caddy');
for (const path of [home, owningHome, controller, caddyRoot])
  mkdirSync(path, { mode: 0o700, recursive: true });
assert.equal(join(home, '.codex-gestalt/gestalt-mobile'), privateRoot);
const proofStarted = Date.now();
const checkpoint = setInterval(() => {
  try {
    let ownerLifecycle = [];
    const path = join(controller, 'live.sqlite');
    if (existsSync(path)) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        ownerLifecycle = db
          .prepare('SELECT record FROM live_runs LIMIT 4')
          .all()
          .map((row) => {
            const value = JSON.parse(row.record);
            return {
              state: [
                'starting',
                'active',
                'stopping',
                'error',
                'recoveryRequired',
                'idle',
              ].includes(value.state)
                ? value.state
                : 'unknown',
              phase:
                typeof value.phase === 'string' && /^[a-zA-Z:-]{1,96}$/.test(value.phase)
                  ? value.phase
                  : 'unknown',
              failureCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(value.failureCode ?? '')
                ? value.failureCode
                : null,
            };
          });
      } finally {
        db.close();
      }
    }
    const target = join(evidence, 'production-entrypoint-progress.json');
    writeFileSync(
      target + '.tmp',
      JSON.stringify(
        {
          ...report,
          passed: false,
          inProgress: true,
          elapsedMs: Date.now() - proofStarted,
          ownerLifecycle,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    renameSync(target + '.tmp', target);
  } catch {
    /* Read-only progress evidence cannot affect readiness or cleanup. */
  }
}, 5000);
checkpoint.unref();
let mobile, caddy, stream, baselineBirth, generationDirectory;
let recoveryHandoff, mobileClose;
async function closeMobileOnce() {
  if (!mobile) return;
  mobileClose ??= mobile.close();
  await mobileClose;
  mobile = undefined;
}
let probeTimer;
let probeActive = false;
let probeRefresh = Promise.resolve();
function stopPreviewProbe() {
  probeActive = false;
  clearInterval(probeTimer);
  stream?.destroy();
  stream = undefined;
}
const privateCanary = randomBytes(32).toString('hex'),
  privateFile = join(privateRoot, 'canary');
writeFileSync(privateFile, privateCanary, { mode: 0o600 });
const mobileTlsPort = editFlow ? await port() : null;
const mobileHttpPort = editFlow ? await port() : null;
const mobileOrigin = `https://mobile.entrypoint.test${editFlow ? `:${mobileTlsPort}` : ''}`;
const rp = { publicOrigin: mobileOrigin, rpId: 'mobile.entrypoint.test', rpName: 'Gestalt Mobile' };
const browserSession = previewSecrets.token();
const headers = { origin: mobileOrigin, cookie: `gestalt_mobile_session=${browserSession}` };
const roles = new Map();
let firstPickerEventId;
let firstPickerObservationStarted;
let contextCompletion;
const editResponse = createProductionEditProvider(appRoot, final, report, {
  lane: proofLane === 'recovery' ? '' : proofLane,
});
let seed = true,
  owningThread,
  owningNativeSession,
  childThread,
  providerFailure;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, stage, budget = 30000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    recoveryHandoff?.assertCurrent();
    if (providerFailure) throw new Error('CONTROLLED_PROVIDER_FAILED');
    if (await check()) return;
    await wait(50);
  }
  throw new Error(stage);
}
// Never read project configuration or remove metadata: the production resolver
// still refuses every unproven project layer. Only bounded owned-fixture facts.
let metadataNativePath;
function ownedProjectMetadata() {
  const folder = join(appRoot, '.codex');
  try {
    const info = lstatSync(folder);
    if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(folder) !== folder)
      return { directoryPresent: true, canonicalDirectory: false };
    const names = readdirSync(folder);
    return {
      directoryPresent: true,
      canonicalDirectory: true,
      ownedByCurrentUser: info.uid === process.getuid(),
      entryCount: Math.min(names.length, 65),
      configEntryPresent: names.includes('config.toml'),
      directoryEntries: names
        .slice(0, 64)
        .filter((name) => lstatSync(join(folder, name)).isDirectory()).length,
      registry: metadataNativePath
        ? projectMetadataRegistryDiagnostics({
            folder,
            temporaryDirectory: '/tmp',
            nativePath: metadataNativePath,
          })
        : undefined,
    };
  } catch (error) {
    return error?.code === 'ENOENT' ? { directoryPresent: false } : { inspectionUnavailable: true };
  }
}
function sampleNativeStartupMetadata() {
  const facts = {
    samples: 0,
    metadataObserved: false,
    syntheticMarkerObserved: false,
    ownedNativeMarkerObserved: false,
  };
  const sample = () => {
    if (facts.samples >= 512) return;
    facts.samples++;
    const metadata = ownedProjectMetadata();
    const registry = projectMetadataRegistryDiagnostics({
      folder: join(appRoot, '.codex'),
      temporaryDirectory: '/tmp',
      nativePath: metadataNativePath,
    });
    facts.metadataObserved ||= metadata.directoryPresent === true;
    facts.syntheticMarkerObserved ||= registry.syntheticMarkers > 0;
    facts.ownedNativeMarkerObserved ||= registry.liveOwnedNativeMarkers > 0;
  };
  sample();
  const timer = setInterval(sample, 10);
  return () => {
    clearInterval(timer);
    sample();
    return facts;
  };
}
function ancestorMetadata() {
  const observations = [];
  for (let path = appRoot, depth = 0; ; path = dirname(path), depth++) {
    try {
      const info = lstatSync(join(path, '.codex'));
      observations.push({
        depth,
        present: true,
        directory: info.isDirectory(),
        symlink: info.isSymbolicLink(),
        currentOwner: info.uid === process.getuid(),
        entries: info.isDirectory()
          ? Math.min(readdirSync(join(path, '.codex')).length, 1000)
          : undefined,
      });
    } catch (error) {
      observations.push({
        depth,
        present: error?.code === 'ENOENT' ? false : undefined,
        unavailable: error?.code !== 'ENOENT',
      });
    }
    if (path === '/') return observations;
  }
}
function protect(path) {
  const info = lstatSync(path);
  assert.equal(info.isSymbolicLink(), false);
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) protect(join(path, name));
    chmodSync(path, 0o500);
  } else {
    assert.ok(info.isFile());
    chmodSync(path, info.mode & 0o111 ? 0o500 : 0o400);
  }
}
function copyFile(source, target, executable = false) {
  writeFileSync(target, readFileSync(source), { flag: 'wx', mode: executable ? 0o500 : 0o400 });
  return pin(target);
}
async function port() {
  const server = portServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
function toolsIn(tools, namespace) {
  return tools.flatMap((tool) =>
    tool.type === 'namespace' ? toolsIn(tool.tools, tool.name) : [{ ...tool, namespace }],
  );
}
function call(tool, id, value, custom = false) {
  const item = custom
    ? { type: 'custom_tool_call', call_id: id, name: tool.name, input: value }
    : { type: 'function_call', call_id: id, name: tool.name, arguments: JSON.stringify(value) };
  if (tool.namespace) item.namespace = tool.namespace;
  return { type: 'response.output_item.done', item };
}
function final(id, text) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      id,
      content: [{ type: 'output_text', text }],
    },
  };
}
function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function childCompletion() {
  if (!childThread) return false;
  let found = false;
  const walk = (path, depth = 0) => {
    if (depth > 5 || !existsSync(path)) return;
    for (const name of readdirSync(path)) {
      const file = join(path, name),
        info = lstatSync(file);
      if (info.isDirectory()) walk(file, depth + 1);
      else if (
        name.endsWith('.jsonl') &&
        name.includes(childThread) &&
        info.size < 4 * 1024 * 1024
      ) {
        const lines = readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        found ||= lines.some(
          (line) =>
            line.type === 'event_msg' &&
            ['task_complete', 'turn_complete'].includes(line.payload?.type),
        );
      }
    }
  };
  walk(join(owningHome, 'sessions'));
  return found;
}
function nativeActivity() {
  const responseKinds = [
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
    'message',
  ];
  const eventKinds = [
    'collab_agent_spawn_begin',
    'collab_agent_spawn_end',
    'error',
    'warning',
    'task_complete',
    'turn_complete',
  ];
  const facts = {
    files: 0,
    rootFiles: 0,
    responseKinds: Object.fromEntries(responseKinds.map((kind) => [kind, 0])),
    eventKinds: Object.fromEntries(eventKinds.map((kind) => [kind, 0])),
  };
  const walk = (path, depth = 0) => {
    if (depth > 5 || !existsSync(path) || facts.files >= 16) return;
    for (const name of readdirSync(path)) {
      const file = join(path, name),
        info = lstatSync(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(file, depth + 1);
      else if (name.endsWith('.jsonl') && info.size < 4 * 1024 * 1024 && facts.files < 16) {
        facts.files++;
        if (owningThread && name.includes(owningThread)) facts.rootFiles++;
        for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (value.type === 'response_item' && responseKinds.includes(value.payload?.type))
            facts.responseKinds[value.payload.type]++;
          if (value.type === 'event_msg' && eventKinds.includes(value.payload?.type))
            facts.eventKinds[value.payload.type]++;
        }
      }
    }
  };
  walk(join(owningHome, 'sessions'));
  return facts;
}
async function eventFor(body) {
  const check = (stage, condition) => {
    report.provider.stage = stage;
    assert.ok(condition);
  };
  report.provider.requestShape = {
    selectedModel: body.model === 'gpt-6-sol',
    selectedThinking: body.reasoning?.effort === 'medium',
    threadMetadata: typeof body.client_metadata?.thread_id === 'string',
    sessionMetadata: typeof body.client_metadata?.session_id === 'string',
  };
  check('selected-model-preserved', body.model === 'gpt-6-sol');
  check('selected-thinking-preserved', body.reasoning?.effort === 'medium');
  const metadata = body.client_metadata;
  check('native-request-thread-identity', typeof metadata?.thread_id === 'string');
  if (seed) {
    owningThread = metadata.thread_id;
    owningNativeSession = metadata.session_id;
    return final('seed', 'Seed completed.');
  }
  assert.equal(metadata.session_id, owningNativeSession);
  const role = metadata.thread_id === owningThread ? 'root' : 'child';
  if (editFlow && role === 'root') firstPickerEventId ??= liveEventFromRequest(body).id;
  if (role === 'child') {
    assert.ok(!childThread || childThread === metadata.thread_id);
    childThread = metadata.thread_id;
  }
  const step = roles.get(role) ?? 0;
  roles.set(role, step + 1);
  report.provider.lastCall = { role, step };
  const available = toolsIn([
    ...(body.tools ?? []),
    ...(body.input ?? [])
      .filter((x) => ['additional_tools', 'tool_search_output'].includes(x.type))
      .flatMap((x) => x.tools ?? []),
  ]);
  const code = available.find((tool) => tool.name === 'exec' && tool.type === 'custom');
  const toolCall = (name, args, custom = false) => {
    const direct = available.find((tool) => tool.name === name);
    if (direct) return call(direct, `${role}-${step}`, args, custom);
    assert.ok(code?.description?.includes(`declare const tools: { ${name}(`));
    return call(
      code,
      `${role}-${step}`,
      `text(await tools.${name}(${JSON.stringify(args)}));`,
      true,
    );
  };
  if (editFlow && role === 'root' && step >= 7) return editResponse(body, toolCall);
  if (step === 1) {
    const output = body.input.find(
      (x) =>
        x.call_id === `${role}-0` &&
        ['function_call_output', 'custom_tool_call_output'].includes(x.type),
    );
    assert.ok(output);
    for (const marker of [
      'production-private-denied',
      'production-control-parent-denied',
      'production-legacy-directory-denied',
    ])
      assert.ok(JSON.stringify(output.output).includes(marker));
  }
  if (step === 0) {
    const artifact = join(appRoot, '.impeccable/live/artifacts', `${role}-exec.txt`);
    const python = `import os\nopen(${JSON.stringify(artifact)},'w').write('permitted-artifact')\nfor p,m in [(${JSON.stringify(privateFile)},'r'),(${JSON.stringify(join(appRoot, '.impeccable/live/future-control.json'))},'w'),(${JSON.stringify(join(appRoot, '.impeccable-live/future-control.json'))},'w')]:\n try:\n  open(p,m).close(); raise RuntimeError('breach')\n except OSError as e:\n  if e.errno not in [1,2,13,20,30]: raise\n  print(['production-private-denied','production-control-parent-denied','production-legacy-directory-denied'][[${JSON.stringify(privateFile)},${JSON.stringify(join(appRoot, '.impeccable/live/future-control.json'))},${JSON.stringify(join(appRoot, '.impeccable-live/future-control.json'))}].index(p)])\n`;
    return toolCall('exec_command', {
      cmd: `/usr/bin/python3 -c ${quote(python)}`,
      workdir: appRoot,
      yield_time_ms: 1000,
      max_output_tokens: 1000,
    });
  }
  if (step === 1)
    return toolCall(
      'apply_patch',
      `*** Begin Patch\n*** Add File: ${join(appRoot, '.impeccable/live/artifacts', `${role}-patch.txt`)}\n+permitted-patch\n*** End Patch`,
      true,
    );
  if (step === 2)
    return toolCall(
      'apply_patch',
      `*** Begin Patch\n*** Add File: ${join(privateRoot, `${role}-forbidden.txt`)}\n+forbidden\n*** End Patch`,
      true,
    );
  if (role === 'root' && step === 3) {
    check('native-context-catalog-advertised', code?.description?.includes('ALL_TOOLS'));
    return call(
      code,
      `${role}-${step}`,
      `const matches=ALL_TOOLS.filter(tool=>/ctx_execute$/.test(tool.name));if(matches.length!==1||typeof tools[matches[0].name]!=='function')throw Error('NATIVE_CONTEXT_CATALOG_UNAVAILABLE');text('production-context-tool-discovered');`,
      true,
    );
  }
  if (role === 'root' && step === 4) {
    const discovery = body.input.find(
      (item) => item.call_id === 'root-3' && item.type === 'custom_tool_call_output',
    );
    check(
      'native-context-catalog-result',
      discovery && JSON.stringify(discovery.output).includes('production-context-tool-discovered'),
    );
    assert.equal(contextCompletion, undefined);
    contextCompletion = new NativeContextCompletion({ startedAt: firstPickerObservationStarted });
    const args = {
      language: 'javascript',
      code: `const fs=await import('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(privateFile)});}catch(e){denied=['EACCES','EPERM','ENOENT','ENOTDIR'].includes(e.code);}if(!denied)throw Error('breach');fs.writeFileSync(${JSON.stringify(join(appRoot, '.impeccable/live/artifacts/context.txt'))},'confined-context');console.log('production-context-denied');`,
      intent: 'Controlled production context confinement probe',
    };
    return call(
      code,
      `${role}-${step}`,
      `const matches=ALL_TOOLS.filter(tool=>/ctx_execute$/.test(tool.name));if(matches.length!==1||typeof tools[matches[0].name]!=='function')throw Error('NATIVE_CONTEXT_CATALOG_UNAVAILABLE');text(await tools[matches[0].name](${JSON.stringify(args)}));`,
      true,
    );
  }
  if (role === 'root' && step === 5) {
    assert.ok(contextCompletion);
    report.provider.contextToolResult = contextToolResultDiagnostic(
      body.input,
      contextCompletion.expectedCallId(),
    );
    let completion;
    try {
      completion = contextCompletion.advance(body.input);
    } finally {
      report.provider.contextProtocol = contextCompletion.diagnostics();
    }
    if (completion.state === 'wait') {
      // Continue this exact Native cell. Never issue a second ctx_execute or
      // advance the deterministic model phase while its original call is pending.
      const wait = available.filter(
        (tool) =>
          tool.name === 'wait' && tool.type === 'function' && tool.namespace === code?.namespace,
      );
      check('native-context-wait-advertised', wait.length === 1);
      roles.set(role, step);
      return call(wait[0], completion.callId, completion.arguments);
    }
    report.checks.actualContextMcpCompletedBeforeArtifactValidation = true;
    check(
      'native-context-artifact',
      existsSync(join(appRoot, '.impeccable/live/artifacts/context.txt')) &&
        readFileSync(join(appRoot, '.impeccable/live/artifacts/context.txt'), 'utf8') ===
          'confined-context',
    );
    const spawnTool = available.find((tool) => tool.name === 'spawn_agent');
    check('native-spawn-advertised', spawnTool);
    const properties = spawnTool.parameters?.properties ?? {};
    check('native-spawn-fork-schema', properties.fork_turns || properties.fork_context);
    return call(spawnTool, `${role}-${step}`, {
      message: 'Run the controlled inherited-confinement probe and finish.',
      agent_type: 'default',
      ...(properties.task_name ? { task_name: 'confined_probe' } : {}),
      ...(properties.fork_turns ? { fork_turns: 'none' } : { fork_context: false }),
    });
  }
  if (role === 'root' && step === 6) {
    const spawned = body.input.find(
      (x) =>
        x.call_id === 'root-5' &&
        ['function_call_output', 'custom_tool_call_output'].includes(x.type),
    );
    const kinds = [
      'function_call_output',
      'custom_tool_call_output',
      'function_call',
      'custom_tool_call',
      'message',
      'additional_tools',
      'item_reference',
      'compaction',
    ];
    const spawnText =
      typeof spawned?.output === 'string'
        ? spawned.output
        : (Array.isArray(spawned?.output) ? spawned.output : [])
            .map((item) => (typeof item.text === 'string' ? item.text : ''))
            .join('');
    const spawnLower = spawnText.slice(0, 65536).toLowerCase();
    report.provider.spawnResponse = {
      kind: spawned?.type ?? 'missing',
      expectedCallIdPresent: body.input.some((x) => x.call_id === 'root-5'),
      inputKinds: Object.fromEntries(
        kinds.map((kind) => [kind, body.input.filter((x) => x.type === kind).length]),
      ),
      markers: [
        'error',
        'thread limit',
        'depth',
        'max_threads',
        'fork',
        'not allowed',
        'denied',
        'unsupported',
        'unknown',
        'agent_id',
        'task_name',
      ].filter((marker) => spawnLower.includes(marker)),
    };
    report.provider.stage = 'native-spawn-response-present';
    // Leave time for an actually spawned child's independent request to arrive
    // before preserving this wire failure; this never satisfies the assertion.
    if (!spawned) await new Promise((done) => setTimeout(done, 10000));
    assert.ok(spawned);
    report.provider.stage = 'native-child-completion';
    await until(childCompletion, 'NATIVE_CHILD_COMPLETION_DEADLINE');
    if (editFlow) return editResponse(body, toolCall);
  }
  return final(
    `${role}-final`,
    role === 'root'
      ? JSON.stringify({
          status: 'error',
          message: 'Controlled admission probe; no UI variant success claimed.',
        })
      : 'Child confinement probe completed.',
  );
}
const provider = createServer(async (req, res) => {
  if (providerFailure) {
    res.writeHead(503);
    res.end();
    return;
  }
  let phase = 'request-method';
  const transport = {
    method: ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'other',
    route: [
      '/v1/models',
      '/v1/responses',
      '/v1/responses/compact',
      '/v1/responses/input_tokens',
      '/',
      '/health',
      '/healthz',
      '/ready',
    ].includes(req.url)
      ? req.url
      : 'other',
    websocket: String(req.headers.upgrade ?? '').toLowerCase() === 'websocket',
  };
  try {
    // Native doctor probes inference reachability without making a model turn.
    // A real Responses endpoint does not accept HEAD as an inference request.
    if (req.method === 'HEAD' && req.url === '/v1/responses') {
      assert.equal(req.headers['transfer-encoding'], undefined);
      assert.ok(
        req.headers['content-length'] === undefined || req.headers['content-length'] === '0',
      );
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ data: [{ id: 'gpt-6-sol', object: 'model', owned_by: 'controlled' }] }),
      );
      return;
    }
    assert.equal(req.method, 'POST');
    phase = 'request-route';
    assert.equal(req.url, '/v1/responses');
    phase = 'request-size';
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      assert.ok(size < 4 * 1024 * 1024);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks),
      encoding = req.headers['content-encoding'];
    phase = 'request-encoding';
    const decode = { gzip: gunzipSync, deflate: inflateSync, zstd: zstdDecompressSync }[encoding];
    assert.ok(!encoding || encoding === 'identity' || decode);
    const bytes = decode ? decode(raw, { maxOutputLength: 4 * 1024 * 1024 }) : raw;
    phase = 'private-canary-absent';
    assert.ok(!bytes.includes(Buffer.from(privateCanary)));
    const helperMetadata = join(appRoot, '.impeccable/live/server.json');
    if (existsSync(helperMetadata)) {
      const bearer = JSON.parse(readFileSync(helperMetadata, 'utf8')).token;
      assert.ok(typeof bearer === 'string' && bearer.length >= 16);
      assert.ok(!bytes.includes(Buffer.from(bearer)));
      report.checks.helperBearerAbsentFromActualProviderWire = true;
    }
    report.provider.requestCount++;
    phase = 'bounded-request-count';
    assert.ok(report.provider.requestCount <= (editFlow ? 40 : 20));
    phase = 'request-json';
    const body = JSON.parse(bytes),
      id = `production-${report.provider.requestCount}`;
    phase = 'model-event';
    const messages = (body.input ?? []).filter((value) => value.type === 'message').slice(-2);
    report.provider.lastMessageMarkers = messages.map((value) => {
      const text = (value.content ?? [])
        .filter((part) => typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .slice(0, 65536)
        .toLowerCase();
      return {
        role: ['user', 'assistant', 'developer', 'system'].includes(value.role)
          ? value.role
          : 'other',
        markers: [
          'unsupported',
          'unknown',
          'invalid',
          'not allowed',
          'function',
          'namespace',
          'code mode',
          'code_mode',
          'not found',
          'error',
          'failed',
          'unavailable',
          'tool',
          'spawn_agent',
          'ctx_execute',
        ].filter((marker) => text.includes(marker)),
      };
    });
    const rawMetadata = body.client_metadata?.['x-codex-turn-metadata'];
    let toolMetadata = body.client_metadata?.tool_namespaces_info;
    try {
      if (!toolMetadata && typeof rawMetadata === 'string' && rawMetadata.length < 262144)
        toolMetadata = JSON.parse(rawMetadata).tool_namespaces_info;
    } catch {
      /* Fixed absence only; never retain malformed metadata. */
    }
    report.provider.exposure = {
      present: !!toolMetadata && typeof toolMetadata === 'object',
      tools: Object.values(toolMetadata && typeof toolMetadata === 'object' ? toolMetadata : {})
        .flatMap((namespace) => Object.values(namespace?.functions ?? {}))
        .filter((tool) => tool?.name === 'spawn_agent' || tool?.name === 'ctx_execute')
        .map((tool) => ({
          target: tool.name === 'spawn_agent' ? 'spawn' : 'context',
          direct: tool.direct === true,
          codeMode: typeof tool.code_mode_name === 'string',
          deferred: tool.deferred === true,
        })),
    };
    const event = await eventFor(body);
    const item = event.item;
    const target = item?.name?.endsWith('ctx_execute')
      ? 'context'
      : ['spawn_agent', 'exec', 'apply_patch'].includes(item?.name)
        ? item.name
        : 'other';
    const namespace = ['functions', 'collaboration'].includes(item?.namespace)
      ? item.namespace
      : item?.namespace === undefined
        ? 'absent'
        : 'other';
    (report.provider.emitted ??= []).push({
      target,
      namespace,
      kind: ['function_call', 'custom_tool_call', 'message'].includes(item?.type)
        ? item.type
        : 'other',
      argumentsString: typeof item?.arguments === 'string',
    });
    phase = 'response-write';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const data of [
      { type: 'response.created', response: { id } },
      event,
      {
        type: 'response.completed',
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      },
    ])
      res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  } catch (error) {
    providerFailure = true;
    report.provider.failureCode =
      error?.code === 'ERR_ASSERTION' ? 'ERR_ASSERTION' : 'CONTROLLED_PROVIDER_FAILED';
    report.provider.failureStage = phase;
    report.provider.failureTransport = transport;
    res.writeHead(503);
    res.end();
  }
});
const sourceIndex = editFlow
  ? '<!doctype html>\n<html>\n<head></head>\n<body>\n<h1 class="hero-title">Owning app</h1>\n<script type="module" src="/app.js"></script>\n</body>\n</html>\n'
  : '<!doctype html><html><head></head><body><h1>Owning app</h1></body></html>\n';
let preview, previewCookie;
async function remote(
  path,
  { method = 'GET', body, streamResponse = false, headersTimeoutMs = 0 } = {},
) {
  return new Promise((done, reject) => {
    let headersTimer;
    const req = httpsRequest(
      new URL(path, preview),
      {
        method,
        ca: readFileSync(join(caddyRoot, 'tls.pem')),
        lookup: (_name, options, callback) =>
          options.all
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4),
        headers: {
          origin: preview,
          'sec-fetch-site': 'same-origin',
          ...(previewCookie ? { cookie: previewCookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        clearTimeout(headersTimer);
        if (streamResponse) {
          res.on('data', () => {});
          done(res);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.once('end', () =>
          done({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.once('error', (error) => {
      clearTimeout(headersTimer);
      reject(error);
    });
    if (headersTimeoutMs > 0)
      headersTimer = setTimeout(
        () => req.destroy(new Error('PREVIEW_HEADERS_TIMEOUT')),
        headersTimeoutMs,
      );
    req.setTimeout(30000, () => req.destroy(new Error('REMOTE_DEADLINE')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function api(method, path, payload) {
  recoveryHandoff?.assertCurrent();
  const res = await mobile.inject({ method, url: path, payload, headers });
  if (res.statusCode >= 400) {
    report.apiFailure = { status: res.statusCode, code: res.json()?.code ?? 'UNCLASSIFIED' };
    throw new Error('PRODUCTION_API_REFUSED');
  }
  return res.json();
}
try {
  report.installationStage = 'provenance';
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(head, process.env.LIVE_PROOF_EXPECTED_HEAD);
  report.provenance = {
    head,
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    agents: 'a6a2758c72220e4845d2735e9776caf8a7e8c43b',
    agentsAcceptedCommit: '18f53c466abcf254f83c9ba83af9f3b1ba5f7882',
    agentsProofSnapshot: 'ba9a7f703b582688009a158cff7392f3f93b4b0e',
    managerAcceptedCommit: '5084cf219163dcf153af1be6f63496dec1bd3d40',
    managerTree: 'dfdeabd2ffdbdb6c429a39c3e81286b611af7734',
    manager: LIVE_MANAGER_SHA256,
  };
  if (proofLane === 'recovery')
    recoveryHandoff = await openRecoveryHandoff({
      directory: process.env.LIVE_PRODUCTION_RECOVERY_CHANNEL,
      socketDirectory: privateRoot,
      identity: candidateIdentity(),
      onCancel: async () => {
        stopPreviewProbe();
        await closeMobileOnce();
      },
    });
  report.installationStage = 'vendor-copy';
  const vendor = join(installation, 'vendor');
  cpSync(dirname(realpathSync(process.env.LIVE_HOST_CODEX_BINARY)), join(vendor, 'bin'), {
    recursive: true,
  });
  report.installationStage = 'vendor-immutability';
  protect(vendor);
  report.installationStage = 'native-and-bwrap-pins';
  const native = pin(join(vendor, 'bin/codex')),
    bwrap = pin(join(vendor, 'bin/codex-resources/bwrap'));
  assert.equal(native.sha256, LIVE_CODEX_SHA256);
  report.nativeBinarySha256 = native.sha256;
  assert.equal(bwrap.sha256, LIVE_CODEX_BWRAP_SHA256);
  metadataNativePath = native.path;
  report.installationStage = 'actual-original-interpreter';
  // The supported original PATH resolves this exact interpreter identity. A
  // byte-identical private copy is not the original executable source.
  const node = pin(realpathSync(process.execPath));
  assert.equal(node.path, '/usr/bin/node');
  report.installationStage = 'manager-copy';
  const manager = copyFile(
    process.env.LIVE_HOST_MANAGER_BINARY,
    join(installation, 'gestalt-manager'),
    true,
  );
  assert.equal(manager.sha256, LIVE_MANAGER_SHA256);
  report.installationStage = 'helper-copy';
  const helper = copyFile(process.env.LIVE_TEST_IMPECCABLE, join(installation, 'impeccable'), true);
  assert.equal(helper.sha256, LIVE_HELPER_BINARY_SHA256);
  report.installationStage = 'worker-copy';
  const worker = copyFile(
    resolve('dist/server/server/platform/live-design/project-process-worker.js'),
    join(installation, 'project-worker.mjs'),
  );
  report.installationStage = 'agents-provenance';
  const agentsRoot = realpathSync(process.env.LIVE_HOST_AGENTS_ROOT);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: agentsRoot, encoding: 'utf8' }).trim(),
    report.provenance.agents,
  );
  report.installationStage = 'agents-package-copy';
  const packages = ['context-mode', 'gestalt'].map((name) => {
    report.installationPackage = name;
    const version =
      name === 'context-mode'
        ? JSON.parse(readFileSync(join(agentsRoot, 'plugins', name, 'package.json'), 'utf8'))
            .version
        : null;
    const target =
      name === 'context-mode'
        ? join(installation, 'cache/context-mode', version)
        : join(installation, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
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
  report.installationStage = 'runtime-preparer-import';
  const { prepareLiveRuntime } = await import(
    pathToFileURL(join(installation, 'gestalt/scripts/prepare-live-runtime.mjs')).href
  );
  report.installationStage = 'runtime-preparation';
  const contextPackage = packages.find((entry) => entry.name === 'context-mode');
  // Ordinary Manager discovery derives this same home without additional env.
  const gestaltHome = join(home, '.gestalt');
  mkdirSync(join(gestaltHome, 'runtime'), { recursive: true, mode: 0o700 });
  const preparedRuntime = await prepareLiveRuntime(
    contextPackage.root,
    join(gestaltHome, 'runtime/context-mode'),
  );
  // Normal HOME/.gestalt is separate from Mobile's denied private state. Keep
  // the required read-only runtime executable while retaining that denial.
  assert.equal(preparedRuntime.root.startsWith(`${privateRoot}/`), false);
  report.installationStage = 'package-immutability-and-inventory';
  for (const entry of packages) {
    protect(entry.root);
    entry.sha256 = measureInstalledLiveTree(entry.root);
  }
  report.installationStage = 'runtime-immutability-and-inventory';
  protect(preparedRuntime.root);
  const runtime = {
    root: preparedRuntime.root,
    sha256: measureInstalledLiveTree(preparedRuntime.root),
  };
  report.installationStage = 'mobile-immutability-and-inventory';
  const mobileRoot = realpathSync(resolve('dist/server'));
  protect(mobileRoot);
  report.installationInventory = {
    native: native.sha256,
    bwrap: bwrap.sha256,
    node: node.sha256,
    manager: manager.sha256,
    helper: helper.sha256,
    worker: worker.sha256,
    packages: packages.map(({ name, sha256 }) => ({ name, sha256 })),
    preparedRuntime: runtime.sha256,
    mobile: measureInstalledLiveTree(mobileRoot),
  };
  report.checks.exactInstalledPreparedBytes = true;
  if (editFlow) {
    assert.equal(
      hash(readFileSync(process.env.LIVE_PUBLISHED_RUNTIME)),
      '65e619d4126e3d3fd10fc5bb7a43d332fe327dbc38e0085883d920a2ba752898',
    );
    execFileSync(
      'tar',
      ['-xzf', process.env.LIVE_PUBLISHED_RUNTIME, '-C', installation, 'source.tar.gz'],
      { stdio: 'pipe' },
    );
    execFileSync(
      'tar',
      ['-xzf', join(installation, 'source.tar.gz'), '-C', installation, 'tests/live-e2e/ui.mjs'],
      { stdio: 'pipe' },
    );
  }
  if (installationOnly) throw new Error('INSTALLATION_ONLY_COMPLETE');
  mkdirSync(join(appRoot, '.impeccable/live'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'production-owning-fixture',
      type: 'module',
      ...(editFlow
        ? {
            devDependencies: {
              vite: JSON.parse(readFileSync(resolve('node_modules/vite/package.json'), 'utf8'))
                .version,
            },
          }
        : {}),
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(appRoot, 'index.html'), sourceIndex, { mode: 0o600 });
  if (editFlow) {
    execFileSync(
      'npm',
      [
        'install',
        '--prefer-offline',
        '--fetch-retries=1',
        '--fetch-timeout=30000',
        '--no-audit',
        '--no-fund',
        '--include=optional',
      ],
      { cwd: appRoot, stdio: 'pipe', timeout: 120000 },
    );
    writeFileSync(
      join(appRoot, 'app.js'),
      "export const marker = 'original';\ndocument.body.dataset.productionHmr = marker;\nif (import.meta.hot) import.meta.hot.accept(next => { document.body.dataset.productionHmr = next.marker; });\n",
      { mode: 0o600 },
    );
  }
  writeFileSync(join(appRoot, 'AGENTS.md'), 'Preserve private state.\n', { mode: 0o644 });
  writeFileSync(
    join(appRoot, 'AGENTS.override.md'),
    'Preserve private state and use the owning session.\n',
    { mode: 0o644 },
  );
  // A real project marker bounds Native discovery to this owned fixture.
  execFileSync('git', ['init', '--quiet', appRoot], { stdio: 'ignore' });
  writeFileSync(
    join(appRoot, '.impeccable/live/config.json'),
    JSON.stringify({ files: ['index.html'], insertBefore: '</body>', commentSyntax: 'html' }),
    { mode: 0o600 },
  );
  const [helperPort, appPort, gatewayPort, previewPort] = await Promise.all(
    Array.from({ length: 4 }, port),
  );
  assert.equal(new Set([helperPort, appPort, gatewayPort, previewPort]).size, 4);
  const devScript = join(installation, 'devserver.mjs');
  writeFileSync(
    devScript,
    editFlow
      ? `import {createServer} from ${JSON.stringify(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)};const server=await createServer({root:${JSON.stringify(appRoot)},configFile:false,server:{host:'127.0.0.1',port:${appPort},strictPort:true,allowedHosts:true,hmr:{protocol:'wss',clientPort:${previewPort}}}});await server.listen();`
      : `import {createServer} from 'node:http';import {readFileSync} from 'node:fs';createServer((_q,r)=>r.end(readFileSync(${JSON.stringify(join(appRoot, 'index.html'))}))).listen(${appPort},'127.0.0.1');`,
    { mode: 0o400 },
  );
  await new Promise((done) => provider.listen(0, '127.0.0.1', done));
  const providerPort = provider.address().port;
  const originalConfig =
    `model = "gpt-6-sol"\nmodel_provider = "controlled"\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\ndefault_permissions = "workspace-git"\n[model_providers.controlled]\nname = "Controlled production fixture"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_snapshot = false\nshell_snapshot_v2 = false\ndaemon_auto_start = false\ncode_mode = false\nmulti_agent = true\nmulti_agent_v2 = true\nhooks = false\n[permissions.workspace-git]\nextends = ":workspace"\n[permissions.workspace-git.filesystem]\n":root" = "read"\n${JSON.stringify(appRoot)} = "write"\n${JSON.stringify(privateRoot)} = "deny"\n${JSON.stringify(`/tmp/codex-daemon-${process.getuid()}`)} = "deny"\n"/proc" = "deny"\n[permissions.workspace-git.network]\nenabled = false\n` +
    `[projects.${JSON.stringify(appRoot)}]\ntrust_level = "trusted"\n`;
  // Configure optional shell snapshot caching OFF in the original source before
  // any Native owner starts. Actual shell/model tools and their sandbox remain
  // mandatory below. Live never overrides an existing owner's snapshot setting
  // or accepts/deletes unproven metadata to make admission pass.
  // Obtain exact generated bridge bytes from the accepted configurator in a
  // separate unused template home. Its hooks remain true and unmodified. The
  // owning fixture below is explicitly hook-free from birth, never a relabeled
  // ordinary installed home or a runtime hooks rewrite.
  const templateHome = join(root, 'configurator-template');
  mkdirSync(templateHome, { mode: 0o700 });
  const { configureCodexIntegration } = await import(
    pathToFileURL(join(contextPackage.root, 'scripts/configure-codex.mjs')).href
  );
  const configured = configureCodexIntegration({
    codexHome: templateHome,
    gestaltHome,
    pluginRoot: contextPackage.root,
    pluginId: 'context-mode@dyne-gestalt-agents',
  });
  const templateConfig = readFileSync(configured.configPath),
    templateHooks = readFileSync(configured.hooksPath);
  assert.match(templateConfig.toString(), /hooks = true/);
  mkdirSync(join(owningHome, 'bin'), { mode: 0o700 });
  const originalBridgePath = join(owningHome, 'bin/context-mode-mcp.mjs');
  writeFileSync(originalBridgePath, readFileSync(configured.launcherPath), {
    mode: 0o755,
    flag: 'wx',
  });
  const installedOriginalConfig =
    originalConfig +
    `\n[marketplaces.dyne-gestalt-agents]\nsource_type = "local"\nsource = ${JSON.stringify(agentsRoot)}\n` +
    `\n[mcp_servers.context-mode]\ncommand = "node"\nargs = [${JSON.stringify(originalBridgePath)}]\nenabled = true\nrequired = true\ndefault_tools_approval_mode = "approve"\n[plugins."context-mode@dyne-gestalt-agents"]\nenabled = false\n[plugins."gestalt@dyne-gestalt-agents"]\nenabled = false\n`;
  // Let pinned Native construct its genuine registry/cache in an unused staging
  // home. Keep its generated enabled config separate; the intended owning home
  // is explicitly disabled from birth and is never repaired by changing settings.
  report.installationStage = 'native-authentic-plugin-registry';
  const registryHome = join(root, 'registry-template');
  mkdirSync(registryHome, { mode: 0o700 });
  const registryEnvironment = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    CODEX_HOME: registryHome,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
  };
  const registryCommand = (args) =>
    JSON.parse(
      execFileSync(native.path, args, {
        env: registryEnvironment,
        cwd: appRoot,
        encoding: 'utf8',
        timeout: 90_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  registryCommand(['plugin', 'marketplace', 'add', agentsRoot, '--json']);
  for (const name of ['gestalt', 'context-mode'])
    registryCommand(['plugin', 'add', `${name}@dyne-gestalt-agents`, '--json']);
  const generatedRegistryConfig = readFileSync(join(registryHome, 'config.toml'));
  assert.equal((generatedRegistryConfig.toString().match(/enabled = true/g) ?? []).length, 2);
  cpSync(join(registryHome, 'plugins'), join(owningHome, 'plugins'), { recursive: true });
  writeFileSync(join(owningHome, 'config.toml'), installedOriginalConfig, { mode: 0o600 });
  const installedPlugins = JSON.parse(
    execFileSync(
      native.path,
      ['plugin', 'list', '--marketplace', 'dyne-gestalt-agents', '--json'],
      {
        env: { ...registryEnvironment, CODEX_HOME: owningHome },
        cwd: appRoot,
        encoding: 'utf8',
        timeout: 90_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  const registryEntries = Array.isArray(installedPlugins)
    ? installedPlugins
    : installedPlugins.installed;
  assert.equal(registryEntries.length, 2);
  assert.deepEqual(registryEntries.map((entry) => entry.name).sort(), ['context-mode', 'gestalt']);
  for (const entry of registryEntries) {
    assert.notEqual(entry.installed, false);
    assert.equal(entry.enabled, false);
    assert.equal(entry.version, originalLaunchSourceVersion());
  }
  function originalLaunchSourceVersion() {
    return JSON.parse(readFileSync(join(contextPackage.root, 'package.json'), 'utf8')).version;
  }
  report.nativeInstalledRegistry = registryEntries.map(({ name, version, enabled }) => ({
    name,
    version,
    enabled,
  }));
  assert.deepEqual(readFileSync(join(registryHome, 'config.toml')), generatedRegistryConfig);
  const originalLaunchSource = {
    kind: 'context-mode-bridge-v1',
    path: originalBridgePath,
    sha256: hash(readFileSync(originalBridgePath)),
    gestaltHome,
    interpreter: node,
    package: {
      root: contextPackage.root,
      version: JSON.parse(readFileSync(join(contextPackage.root, 'package.json'), 'utf8')).version,
      treeDigest: contextPackage.sha256,
    },
    runtime: { root: runtime.root, treeDigest: runtime.sha256 },
  };
  assert.equal(lstatSync(originalBridgePath).mode & 0o7777, 0o755);
  assert.deepEqual(readFileSync(configured.configPath), templateConfig);
  assert.deepEqual(readFileSync(configured.hooksPath), templateHooks);
  report.originalInstalledSurface = {
    authenticConfiguratorBridgeBytes: true,
    authenticPreparedRuntime: true,
    explicitHookFreeOwningFixture: true,
    ordinaryInstalledHomeEligible: false,
    originalMode: '0755',
    originalEnabled: true,
    originalRequired: true,
    packageExplicitlyDisabled: true,
    templateHooksPreserved: true,
  };

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(caddyRoot, 'tls.key'),
      '-out',
      join(caddyRoot, 'tls.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=*.preview.entrypoint.test',
      '-addext',
      'subjectAltName=DNS:preview.entrypoint.test,DNS:*.preview.entrypoint.test,DNS:mobile.entrypoint.test',
    ],
    { stdio: 'ignore' },
  );
  const caddySocket = join(caddyRoot, 'admin.sock'),
    credential = join(caddyRoot, 'credential'),
    caddyConfig = join(caddyRoot, 'caddy.json');
  writeFileSync(credential, previewSecrets.token(), { mode: 0o600 });
  writeFileSync(
    caddyConfig,
    JSON.stringify({
      admin: { listen: `unix/${caddySocket}` },
      apps: {
        tls: {
          certificates: {
            load_files: [
              { certificate: join(caddyRoot, 'tls.pem'), key: join(caddyRoot, 'tls.key') },
            ],
          },
        },
        http: {
          servers: {
            fixture: {
              listen: [editFlow ? `:${mobileTlsPort}` : '127.0.0.1:0'],
              ...(editFlow
                ? { tls_connection_policies: [{}], automatic_https: { disable: true } }
                : {}),
              routes: [
                {
                  handle: [
                    editFlow
                      ? {
                          handler: 'reverse_proxy',
                          upstreams: [{ dial: `127.0.0.1:${mobileHttpPort}` }],
                        }
                      : { handler: 'static_response', body: 'fixture' },
                  ],
                },
              ],
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  if (!constructionOnly) {
    caddy = spawn(process.env.LIVE_TEST_CADDY, ['run', '--config', caddyConfig], {
      env: { PATH: '/usr/bin:/bin', HOME: caddyRoot },
      stdio: 'ignore',
    });
    await until(() => existsSync(caddySocket), 'CADDY_START_DEADLINE');
  }
  const auth = new SqliteAuthorizationStore(home, rp);
  assert.equal(auth.path, join(privateRoot, 'auth.sqlite'));
  report.checks.normalHomeRuntimeSeparateFromDeniedMobileAuth = true;
  const owner = auth.initializeOwner(randomBytes(32));
  auth.claimFirstDevice(owner, {
    id: 'fixture-device',
    credentialId: 'fixture-credential',
    publicKey: new Uint8Array([1]),
    counter: 0,
    version: 0,
    transports: ['internal'],
    deviceType: 'singleDevice',
    backedUp: false,
    nickname: 'Fixture device',
    createdAt: new Date().toISOString(),
  });
  auth.saveSession(browserSession, {
    deviceId: 'fixture-device',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  auth.close();
  const configPath = join(privateRoot, 'production.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      privateDirectory: controller,
      installation: { manager, node, packages, runtime },
      mobile: { root: mobileRoot, sha256: measureInstalledLiveTree(mobileRoot) },
      native,
      nativeEnvironment: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        CODEX_HOME: owningHome,
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
      },
      providerCredentialEnvironment: [],
      project: { bwrap, node, worker, helper },
      components: {
        manager: report.provenance.managerAcceptedCommit,
        mobile: report.provenance.tree,
        agents: report.provenance.agents,
      },
      caddy: {
        controllerDirectory: caddyRoot,
        socketPath: caddySocket,
        credentialPath: credential,
        hostname: 'preview.entrypoint.test',
        previewPorts: [previewPort],
      },
      apps: [
        {
          appId: 'owning-app',
          targetId: 'owned-devserver',
          appRoot,
          workspaceRoot: appRoot,
          plans: [],
          owningPolicy: {
            profileId: 'workspace-git',
            configFiles: [pin(join(owningHome, 'config.toml'))],
            instructionFiles: [],
            originalLaunchSources: [originalLaunchSource],
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
                    { path: { type: 'path', path: appRoot }, access: 'write' },
                    ...[privateRoot, `/tmp/codex-daemon-${process.getuid()}`, '/proc'].map(
                      (path) => ({ path: { type: 'path', path }, access: 'deny' }),
                    ),
                  ],
                },
              },
              sandboxCwd: pathToFileURL(appRoot).href,
              useLegacyLandlock: false,
            },
          },
          helperPort,
          gatewayPort,
          devserver: {
            executable: node,
            argv: [devScript],
            environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
            launchInputs: [pin(devScript)],
            port: appPort,
            cacheDirectories: [],
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  report.projectMetadata = {
    beforeOwner: ownedProjectMetadata(),
    ancestorsBeforeComposition: ancestorMetadata(),
  };
  report.stage = 'sole-production-composition';
  recoveryHandoff?.assertCurrent();
  mobile = await composeRelayApp({
    root: appRoot,
    dataDir: join(privateRoot, 'relay'),
    homeDirectory: home,
    relyingParty: rp,
    liveConfigFile: configPath,
    installedCodexVersion: 'codex-cli 0.161.0',
    startAppServers: true,
    xerj: 'off',
    ...(editFlow ? { staticDir: resolve('dist/client') } : {}),
    profiles: {
      list: async () => [],
      require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
    },
  });
  report.checks.soleProductionCompositionConstructed = true;
  if (editFlow) await mobile.listen({ host: '127.0.0.1', port: mobileHttpPort });
  report.projectMetadata.afterComposition = ownedProjectMetadata();
  if (constructionOnly) throw new Error('CONSTRUCTION_ONLY_COMPLETE');
  report.stage = 'ordinary-installed-auxiliary-discovery';
  const models = await api('POST', '/api/session-models/codex', {});
  assert.ok(Array.isArray(models.models) && models.models.length > 0);
  report.checks.ordinaryInstalledAuxiliaryModelDiscovery = true;
  const skills = await api(
    'GET',
    `/api/skills?workspaceId=${workspaceId(appRoot)}&profile=default&refresh=true`,
  );
  assert.ok(Array.isArray(skills.skills));
  assert.deepEqual(skills.errors, []);
  assert.equal(
    skills.skills.some((skill) => /\/plugins\/cache\/dyne-gestalt-agents\//.test(skill.path)),
    false,
  );
  report.checks.ordinaryInstalledAuxiliarySkillsExcludeDisabledPackages = true;
  report.stage = 'actual-owning-session';
  const stopMetadataSampling = sampleNativeStartupMetadata();
  let session;
  try {
    session = await api('POST', '/api/sessions', {
      workspaceId: workspaceId(appRoot),
      profile: 'default',
      provider: 'codex',
      model: 'gpt-6-sol',
      reasoningEffort: 'medium',
      sandbox: 'workspace-git',
      approvalPolicy: 'never',
    });
  } finally {
    report.projectMetadata.duringSessionCreate = stopMetadataSampling();
  }
  report.projectMetadata.afterSessionCreate = ownedProjectMetadata();
  assert.equal(session.state, 'ready');
  assert.equal(typeof session.threadId, 'string');
  report.checks.actualOwningStartupAdmitted = true;
  if (preflightOnly && !seededPreflight) {
    owningThread = session.threadId;
    report.projectMetadata.afterSeed = report.projectMetadata.afterSessionCreate;
    report.preflightSeedSkipped = true;
  } else {
    await api('POST', `/api/sessions/${session.id}/turns`, {
      text: 'Seed owning thread persistence.',
    });
    await until(async () => {
      const current = await api('GET', `/api/sessions/${session.id}`);
      return !current.activeTurnId && report.provider.requestCount === 1;
    }, 'OWNING_SEED_DEADLINE');
    report.projectMetadata.afterSeed = ownedProjectMetadata();
  }
  report.stage = 'compatible-original-startup';
  for (const facts of [
    report.projectMetadata.afterSessionCreate,
    report.projectMetadata.afterSeed,
  ]) {
    if (facts.directoryPresent) {
      assert.equal(facts.canonicalDirectory, true);
      assert.equal(facts.ownedByCurrentUser, true);
      assert.equal(facts.entryCount, 0);
    }
  }
  report.checks.originalStartupMetadataRetainedWithoutDeletion = true;
  report.checks.persistedBaselineWithoutPreAdmissionCommands = true;
  seed = false;
  assert.equal(owningThread, session.threadId);
  const operation = {
    appId: 'owning-app',
    targetId: 'owned-devserver',
    operationId: 'production-admission',
  };
  report.stage = 'production-start-admission';
  const startAdmissionBegan = performance.now();
  let started;
  if (editFlow) {
    await productionEditBrowser({
      privateRoot,
      certificate: join(caddyRoot, 'tls.pem'),
      report,
      browser: {
        startThroughControls: true,
        startObservationBudgetMs,
        mobileOrigin,
        sessionId: session.id,
        sessionCookie: browserSession,
        uiModule: join(installation, 'tests/live-e2e/ui.mjs'),
        resultFile: join(evidence, 'production-controls-start-browser.json'),
        screenshot: join(evidence, 'production-controls-start.png'),
      },
      command: async () => {
        throw new Error('START_BROWSER_COMMAND_UNAVAILABLE');
      },
    });
    report.mobileControlsStart = report.editBrowser;
    started = report.mobileControlsStart.startedRun;
    operation.operationId = report.mobileControlsStart.operationId;
    assert.equal(report.mobileControlsStart.startThroughMobileControls, true);
    report.checks.actualMobileUiStartWithProductionAuthentication = true;
  } else started = await api('POST', `/api/sessions/${session.id}/live/start`, operation);
  report.startAdmissionElapsedMs = Math.round(performance.now() - startAdmissionBegan);
  assert.equal(started.state, 'active');
  preview = started.previewOrigin;
  generationDirectory = readdirSync(controller)
    .filter((name) => name.startsWith('owner-'))
    .map((name) => join(controller, name))[0];
  assert.ok(generationDirectory);
  const observed = JSON.parse(
    readFileSync(join(generationDirectory, 'owning-configuration.json'), 'utf8'),
  );
  assert.equal(observed.configuration.config.features.shell_snapshot, false);
  assert.equal(observed.configuration.config.features.shell_snapshot_v2, false);
  assert.equal(
    observed.configuration.layers.some(
      (layer) =>
        layer.name.type === 'user' &&
        layer.config.features?.shell_snapshot === false &&
        layer.config.features?.shell_snapshot_v2 === false,
    ),
    true,
  );
  report.checks.actualOriginalSnapshotConfigurationPreserved = true;
  const liveDb = new DatabaseSync(join(controller, 'live.sqlite'), { readOnly: true });
  try {
    const live = JSON.parse(
      liveDb.prepare('SELECT record FROM live_runs WHERE liveId=?').get(started.liveId).record,
    );
    assert.equal(live.globallyExclusive, true);
    assert.equal(live.rootThreadId, owningThread);
    report.checks.actualBroadScratchScopeRemainsGloballyExclusive = true;
  } finally {
    liveDb.close();
  }
  baselineBirth = observed.launch;
  assert.equal(observedBirthExited(baselineBirth), false);
  assert.equal(readFileSync(join(owningHome, 'config.toml'), 'utf8'), installedOriginalConfig);
  for (const name of ['policy-receipt.json', 'admission-receipt.json'])
    report.checks[name.replaceAll('-', '_')] = existsSync(join(generationDirectory, name));
  const stable = (value) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item,
    );
  const signingKey = readFileSync(join(controller, 'live-policy.key'));
  const signed = (path) => {
    const receipt = JSON.parse(readFileSync(path));
    assert.equal(
      createHmac('sha256', signingKey).update(stable(receipt.body)).digest('hex'),
      receipt.mac,
    );
    return receipt.body;
  };
  const manifest = JSON.parse(readFileSync(join(generationDirectory, 'manifest.json')));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.generation.sessionId, session.id);
  assert.equal(manifest.generation.generation, started.generation);
  const captureId = manifest.runtimeProvenance.captureId;
  const before = signed(join(generationDirectory, `birth-${captureId}.json`));
  const image = signed(join(generationDirectory, `image-${captureId}.json`));
  const sealed = signed(join(generationDirectory, `runtime-${captureId}.json`));
  assert.equal(before.kind, 'before-runtime-birth');
  assert.ok(
    before.configs.some(
      (entry) =>
        entry.path === join(owningHome, 'config.toml') &&
        entry.sha256 === hash(Buffer.from(installedOriginalConfig)),
    ),
  );
  assert.ok(
    sealed.inventory.sources.some(
      (entry) =>
        entry.kind === 'file' &&
        entry.path === join(owningHome, 'config.toml') &&
        entry.sha256 === hash(Buffer.from(installedOriginalConfig)),
    ),
  );
  report.checks.disabledPluginMetadataRemainsInSignedOriginalConfig = true;
  assert.equal(image.process.pid, baselineBirth.pid);
  assert.equal(sealed.runtime.process.pid, baselineBirth.pid);
  assert.equal(sealed.runtime.process.birth, baselineBirth.birth);
  assert.ok(
    sealed.inventory.sources.some(
      (source) =>
        source.kind === 'instruction' && source.path === join(appRoot, 'AGENTS.override.md'),
    ),
  );
  assert.ok(
    sealed.inventory.sources.some(
      (source) =>
        source.kind === 'instruction-candidate' && source.path === join(appRoot, 'AGENTS.md'),
    ),
  );
  assert.equal(sealed.inventory.observation.sessionFlags.model, session.model);
  assert.equal(
    sealed.inventory.observation.sessionFlags.reasoningEffort,
    session.modelSettings.reasoningEffort,
  );
  assert.match(sealed.inventory.observation.accountDigest, /^[a-f0-9]{64}$/);
  report.sourceInventory = {
    schemaVersion: sealed.inventory.schemaVersion,
    signatureVerified: true,
    sourceKinds: sealed.inventory.sources.map((source) => source.kind),
    captureGenerationMatchesLiveGeneration: true,
  };
  assert.deepEqual(manifest.originalLaunchSources, [originalLaunchSource]);
  assert.deepEqual(before.originalLaunchSources[0].descriptor, originalLaunchSource);
  assert.deepEqual(
    sealed.inventory.sources.find((source) => source.kind === 'installed-launch-source'),
    before.originalLaunchSources[0],
  );
  report.checks.installedExecutableSourceSeparatelySignedAndSealed = true;
  report.checks.originalManagedOwnerRetainedWithSignedV2Sources = true;
  report.checks.productionContextNativeAdmissionProbe = true; // active follows the actual fixed context probe, never a fixture callback.
  const reused = await api('POST', `/api/sessions/${session.id}/live/start`, operation);
  assert.equal(reused.liveId, started.liveId);
  assert.equal(reused.generation, started.generation);
  report.checks.sameSessionReuseNoReplacement = true;
  if (preflightOnly) {
    assert.equal(report.provider.requestCount, seededPreflight ? 1 : 0);
    const catalogs = report.nativeLaunchLifetimes.flatMap((launch) => launch.owningCatalogs ?? []);
    const sameThread = catalogs.filter((row) => row.threadIdDigest === hash(session.threadId));
    assert.ok(
      sameThread.some(
        (row) => row.name === 'context-mode' && row.status === 'connected' && row.toolCount === 11,
      ),
    );
    for (const [name, count] of [
      ['context-mode', 7],
      ['gestalt-org-plan', 12],
    ]) {
      assert.ok(
        sameThread.some(
          (row) => row.name === name && row.status === 'failed' && row.toolCount === 0,
        ),
      );
      assert.ok(
        sameThread.some(
          (row) => row.name === name && row.status === 'connected' && row.toolCount === count,
        ),
      );
    }
    const processes = readdirSync(generationDirectory)
      .filter((name) => /^process-[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => signed(join(generationDirectory, name)));
    assert.ok(
      processes.some(
        (receipt) =>
          receipt.commandId === 'context-mode-call' &&
          receipt.postSpawnValidated === true &&
          receipt.status === 'exited' &&
          receipt.termination === 'leader-exit' &&
          receipt.policy.manifestDigest ===
            hash(readFileSync(join(generationDirectory, 'manifest.json'))),
      ),
    );
    report.preflight = {
      sameOwningNativeBirth: true,
      originalCatalog11: true,
      originalRetiredBeforeSeal: true,
      terminalPresealZeroTools: true,
      actualPostsealCatalog7And12: true,
      currentSignedPostSpawnProbe: true,
      actualProductionStartActive: true,
      modelRequests: report.provider.requestCount,
    };
    report.stage = 'preflight-revoke-and-shutdown';
    await mobile.close();
    mobile = undefined;
    assert.equal(
      signed(join(controller, `runtime-admission-${hash(appRoot)}.json`)).status,
      'revoked',
    );
    assert.equal(observedBirthExited(baselineBirth), true);
    assert.equal(readFileSync(join(owningHome, 'config.toml'), 'utf8'), installedOriginalConfig);
    assert.equal(existsSync(join(appRoot, '.impeccable/live/inject-journal.json')), false);
    report.checks.preflightRevokeCloseAndOriginalConfigurationPreserved = true;
    report.cleanupComplete = true;
    throw new Error('ADMISSION_PREFLIGHT_COMPLETE');
  }
  report.stage = 'authenticated-preview-exchange';
  const verifier = previewSecrets.token();
  const grant = await api('POST', `/api/sessions/${session.id}/live/launch-grants`, {
    liveId: started.liveId,
    generation: started.generation,
    codeChallenge: previewSecrets.challenge(verifier),
    codeChallengeMethod: 'S256',
  });
  const exchanged = await remote('/__gestalt_live/exchange', {
    method: 'POST',
    body: { grantId: grant.grantId, grant: grant.grant, codeVerifier: verifier },
  });
  report.previewExchangeStatus = exchanged.status;
  assert.equal(exchanged.status, 201);
  previewCookie = exchanged.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
  report.stage = 'authenticated-preview-app';
  const previewApp = await remote('/');
  report.previewAppStatus = previewApp.status;
  assert.equal(previewApp.status, 200);
  const token = JSON.parse(
    readFileSync(join(appRoot, '.impeccable/live/server.json'), 'utf8'),
  ).token;
  report.stage = 'authenticated-helper-stream';
  stream = await remote(`/__gestalt_live/events?token=${encodeURIComponent(token)}`, {
    streamResponse: true,
  });
  report.previewStreamStatus = stream.statusCode;
  assert.equal(stream.statusCode, 200);
  const previewProbeOpenedAt = Date.now();
  if (editFlow) {
    probeActive = true;
    const deadline = Date.now() + 120000;
    let refreshing = false;
    probeTimer = setInterval(() => {
      if (!probeActive || refreshing) return;
      if (Date.now() >= deadline) {
        report.previewProbeFailure = 'PREVIEW_PROBE_HANDOFF_TIMEOUT';
        stopPreviewProbe();
        return;
      }
      refreshing = true;
      probeRefresh = (async () => {
        // Behave like an EventSource client across the unchanged 60s physical
        // stream lifetime. Reuse the existing cookie/lease/generation only.
        const next = await remote(
          `/__gestalt_live/events?token=${encodeURIComponent(token)}&clientId=probe-${randomBytes(8).toString('hex')}`,
          { streamResponse: true, headersTimeoutMs: 10000 },
        );
        if (!probeActive) {
          next.destroy();
          return;
        }
        if (next.statusCode !== 200) {
          report.previewProbeDeniedStatus = next.statusCode;
          next.destroy();
          throw new Error('PREVIEW_PROBE_RECONNECT_DENIED');
        }
        const previous = stream;
        stream = next;
        previous?.destroy();
        report.previewProbeReconnects = (report.previewProbeReconnects ?? 0) + 1;
      })()
        .catch((error) => {
          report.previewProbeErrorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '')
            ? error.code
            : /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? '')
              ? error.message
              : 'UNCLASSIFIED';
          report.previewProbeFailure = 'PREVIEW_PROBE_RECONNECT_DENIED';
          stopPreviewProbe();
        })
        .finally(() => (refreshing = false));
    }, 20000);
  }
  report.checks.authenticatedPrivatePipePreviewThroughRealTls = true;
  report.stage = 'production-owning-model-tools';
  if (editFlow) {
    const requestsBeforeWriterProbes = report.provider.requestCount;
    for (const [method, suffix, payload] of [
      ['POST', '/turns', { text: 'An ordinary writer must not run.' }],
      ['PUT', '/autopilot', { enabled: true }],
      ['PUT', '/plan', { planName: 'picker-proof.org' }],
    ]) {
      const denied = await mobile.inject({
        method,
        url: `/api/sessions/${session.id}${suffix}`,
        payload,
        headers,
      });
      (report.writerProbes ??= []).push({
        method,
        suffix,
        status: denied.statusCode,
        code: denied.json().code,
      });
      assert.equal(denied.statusCode, 409);
      assert.equal(denied.json().code, 'LIVE_MODE_ACTIVE');
    }
    assert.equal(report.provider.requestCount, requestsBeforeWriterProbes);
    report.checks.chatAutopilotOrgWritersRefusedDuringPickerFlow = true;
    let manualSource;
    let backgroundSourceDigest, backgroundRequestCount;
    const acknowledged = async (kind) =>
      until(
        () => {
          const db = new DatabaseSync(
            join(
              controller,
              `inbox-${hash(`${statSync(appRoot).dev}:${statSync(appRoot).ino}`)}.sqlite`,
            ),
            {
              readOnly: true,
            },
          );
          try {
            return db
              .prepare('SELECT record FROM live_event_inbox')
              .all()
              .some((row) => {
                const item = JSON.parse(row.record);
                return item.kind === kind && item.stage === 'acknowledged';
              });
          } finally {
            db.close();
          }
        },
        'EDIT_CANONICAL_ACK_DEADLINE',
        eventObservationBudgetMs,
      );
    report.previewProbeAgeAtBrowserStartMs = Date.now() - previewProbeOpenedAt;
    report.browserCpuWindowStartUs = Number(process.hrtime.bigint() / 1000n);
    browserEventLoop.enable();
    await productionEditBrowser({
      privateRoot,
      certificate: join(caddyRoot, 'tls.pem'),
      report,
      checkpoint: (stage) => {
        if (stage === 'picker-generate' || stage === 'picker-manual-apply')
          firstPickerObservationStarted ??= performance.now();
        if (stage === 'helper-connected') {
          stopPreviewProbe();
          report.checks.previewProbeHandedToActualBrowserConnection = true;
        }
      },
      browser: {
        mobileOrigin,
        previewOrigin: preview,
        sessionId: session.id,
        liveId: started.liveId,
        generation: started.generation,
        helperTokenSha256: hash(token),
        pickerSmoke,
        proofLane,
        eventObservationBudgetMs,
        sessionCookie: browserSession,
        uiModule: join(installation, 'tests/live-e2e/ui.mjs'),
        resultFile: join(evidence, 'production-edit-browser.json'),
        screenshot: join(evidence, 'production-picker-edit.png'),
      },
      command: async (command) => {
        const source = () => readFileSync(join(appRoot, 'index.html'), 'utf8');
        if (command === 'accepted') {
          await acknowledged('accept');
          assert.ok(source().includes('Production chosen variant'));
          assert.ok(!source().includes('impeccable-variants-start'));
        } else if (command === 'steered') {
          await acknowledged('steer');
          assert.ok(readFileSync(join(appRoot, 'app.js'), 'utf8').includes("marker = 'steered'"));
        } else if (command === 'manual-applied') {
          await acknowledged('manual_edit_apply');
          manualSource = source();
          assert.ok(manualSource.includes('Production manual approved'));
          assert.ok(
            !/contenteditable|data-impeccable-editable|impeccable-variants-start/.test(
              manualSource,
            ),
          );
        } else if (command === 'discarded') {
          await acknowledged('discard');
          assert.equal(source(), manualSource);
        } else if (command === 'background-begin') {
          backgroundSourceDigest = hash(source());
          backgroundRequestCount = report.provider.requestCount;
        } else if (command === 'background-finished') {
          assert.equal(hash(source()), backgroundSourceDigest);
          assert.equal(report.provider.requestCount, backgroundRequestCount);
          const status = await api('GET', `/api/sessions/${session.id}/live`);
          assert.ok(['active', 'recoveryRequired'].includes(status.state));
          report.background = { state: status.state, noModelOrSourceEffect: true };
        } else throw new Error('EDIT_BROWSER_COMMAND_UNAVAILABLE');
      },
    });
    finishBrowserProfile();
    if (proofLane || pickerDiagnostic) {
      const required = pickerDiagnostic
        ? ['generate', 'accept']
        : proofLane === 'accept-steer'
          ? ['generate', 'accept', 'steer']
          : ['manual_edit_apply', 'generate', 'discard'];
      const db = new DatabaseSync(
        join(
          controller,
          `inbox-${hash(`${statSync(appRoot).dev}:${statSync(appRoot).ino}`)}.sqlite`,
        ),
        { readOnly: true },
      );
      try {
        const records = db
          .prepare('SELECT record FROM live_event_inbox')
          .all()
          .map((row) => JSON.parse(row.record));
        report.laneCanonicalEvents = required.map((kind) => {
          const matches = records.filter((record) => record.kind === kind);
          assert.equal(matches.length, 1);
          assert.equal(matches[0].stage, 'acknowledged');
          assert.deepEqual(matches[0].history, [
            'received',
            'dispatched',
            'applied',
            'acknowledged',
          ]);
          return { kind, stage: matches[0].stage, history: matches[0].history };
        });
      } finally {
        db.close();
      }
    }
    assert.equal(report.previewProbeFailure, undefined);
    if (proofLane !== 'manual-discard')
      assert.equal(report.editBrowser.realPickerGenerateAccept, true);
    if (pickerSmoke || proofLane === 'accept-steer') {
      report.checks.actualPickerGenerateAcceptWithCanonicalSourceEffect = true;
      if (proofLane) {
        assert.equal(report.editBrowser.realPickerSteer, true);
        assert.ok(report.editBrowser.hmrUpdates > 0);
        assert.equal(report.editBrowser.actualTabHiddenBeyondEightSeconds, true);
        assert.equal(report.background.noModelOrSourceEffect, true);
        report.checks.actualPickerSteerWithCanonicalHmrEffect = true;
        report.checks.actualBackgroundBeyondEightSecondsPreservesFencing = true;
      }
    } else if (proofLane === 'manual-discard') {
      assert.equal(report.editBrowser.realPickerManualApply, true);
      assert.equal(report.editBrowser.realPickerDiscard, true);
      report.checks.actualPickerManualApplyGenerateDiscardWithExactSourceRestoration = true;
    } else {
      report.checks.realPickerGenerateSteerManualApplyAcceptDiscard = true;
      report.checks.actualBackgroundBeyondEightSecondsPreservesFencing =
        report.editBrowser.actualTabHiddenBeyondEightSeconds &&
        report.background.noModelOrSourceEffect;
      report.checks.canonicalJournalSourceEffectsAndDiscardRestoration = true;
      report.checks.actualViteHmrThroughAuthenticatedGateway = report.editBrowser.hmrUpdates > 0;
    }
    assert.equal(report.editBrowser.openThroughMobileControls, true);
    report.checks.actualMobileUiOpenAuthenticatedRemoteOverlay = true;
  } else if (!recoveryOnly) {
    firstPickerObservationStarted ??= performance.now();
    const event = await remote(`/__gestalt_live/events?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: {
        token,
        type: 'generate',
        id: 'f00df00d',
        count: 1,
        action: 'polish',
        element: { outerHTML: '<h1>Owning app</h1>' },
      },
    });
    report.modelEventStatus = event.status;
    assert.equal(event.status, 200);
  }
  if (!recoveryOnly) {
    await until(
      () => roles.get('root') >= 7 && roles.get('child') >= 4 && childCompletion(),
      'PRODUCTION_MODEL_CHILD_DEADLINE',
      60000,
    );
    for (const role of ['root', 'child']) {
      assert.equal(
        readFileSync(join(appRoot, '.impeccable/live/artifacts', `${role}-exec.txt`), 'utf8'),
        'permitted-artifact',
      );
      assert.equal(
        readFileSync(join(appRoot, '.impeccable/live/artifacts', `${role}-patch.txt`), 'utf8'),
        'permitted-patch\n',
      );
      assert.equal(existsSync(join(privateRoot, `${role}-forbidden.txt`)), false);
    }
    assert.equal(
      readFileSync(join(appRoot, '.impeccable/live/artifacts/context.txt'), 'utf8'),
      'confined-context',
    );
    assert.equal(existsSync(join(appRoot, '.impeccable/live/future-control.json')), false);
    assert.equal(existsSync(join(appRoot, '.impeccable-live/future-control.json')), false);
    assert.equal(readFileSync(privateFile, 'utf8'), privateCanary);
    report.checks.actualModelToolsAndChildInheritedConfinement = true;
    report.checks.nativeModelContextToolConfined = true;
    report.checks.futureControlDenialsAndArtifactCarveouts = true;
    await until(() => {
      const db = new DatabaseSync(
        join(
          controller,
          `inbox-${hash(`${statSync(appRoot).dev}:${statSync(appRoot).ino}`)}.sqlite`,
        ),
        { readOnly: true },
      );
      try {
        return db
          .prepare('SELECT record FROM live_event_inbox')
          .all()
          .some((row) => {
            const r = JSON.parse(row.record);
            return (
              r.upstreamId === (editFlow ? firstPickerEventId : 'f00df00d') &&
              r.stage === 'acknowledged'
            );
          });
      } finally {
        db.close();
      }
    }, 'CANONICAL_INBOX_ACK_DEADLINE');
  }
  const current = await api('GET', `/api/sessions/${session.id}`);
  assert.equal(current.threadId, owningThread);
  assert.equal(current.model, 'gpt-6-sol');
  assert.equal(current.modelSettings.reasoningEffort, 'medium');
  report.checks[
    recoveryOnly
      ? 'sameOwningThreadModelThinkingWithoutModelTurn'
      : 'sameOwningThreadModelThinkingAndDurableInbox'
  ] = true;
  let recovery;
  if ((editFlow && !pickerSmoke && !proofLane) || recoveryOnly) {
    if (recoveryHandoff) {
      report.stage = 'recovery-phase-ready';
      await recoveryHandoff.boundary();
    }
    stopPreviewProbe();
    recovery = await productionRecoveryProof({
      api,
      inject: (method, url, payload) => {
        recoveryHandoff?.assertCurrent();
        return mobile.inject({ method, url, payload, headers });
      },
      remote,
      until,
      report,
      session: current,
      started,
      controller,
      appRoot,
      privateRoot,
      signed,
      expectedSourceText: recoveryOnly ? 'Owning app' : 'Production manual approved',
      eventObservationBudgetMs,
      // Manager's signed process identity omits bootId; bind its PID/birth to
      // the actual original launch's boot before using Mobile's exit observer.
      owningBirthExited: (identity) =>
        observedBirthExited({ ...identity, bootId: baselineBirth.bootId }),
      ownedProcesses: () => [...projectProcesses.keys()].map((owned) => owned.diagnostics()),
      authenticate: async (run) => {
        const verifier = previewSecrets.token();
        const grant = await api('POST', `/api/sessions/${session.id}/live/launch-grants`, {
          liveId: run.liveId,
          generation: run.generation,
          codeChallenge: previewSecrets.challenge(verifier),
          codeChallengeMethod: 'S256',
        });
        const exchanged = await remote('/__gestalt_live/exchange', {
          method: 'POST',
          body: { grantId: grant.grantId, grant: grant.grant, codeVerifier: verifier },
        });
        assert.equal(exchanged.status, 201);
        previewCookie = exchanged.headers['set-cookie']
          .map((cookie) => cookie.split(';')[0])
          .join('; ');
        const token = JSON.parse(
          readFileSync(join(appRoot, '.impeccable/live/server.json'), 'utf8'),
        ).token;
        const opened = await remote(`/__gestalt_live/events?token=${encodeURIComponent(token)}`, {
          streamResponse: true,
        });
        assert.equal(opened.statusCode, 200);
        return opened;
      },
    });
  }
  report.stage = 'revoke-and-production-shutdown';
  stopPreviewProbe();
  await closeMobileOnce();
  assert.equal(existsSync(join(controller, 'live-policy.key')), true);
  const fence = signed(join(controller, `runtime-admission-${hash(appRoot)}.json`));
  assert.equal(fence.status, 'revoked');
  assert.equal(fence.captureId, recovery?.latestCaptureId ?? captureId);
  assert.equal(observedBirthExited(baselineBirth), true);
  report.checks.signedRevocationPrecedesOriginalOwnerExit = true;
  if (editFlow) {
    const source = readFileSync(join(appRoot, 'index.html'), 'utf8');
    assert.ok(
      source.includes(
        pickerSmoke || proofLane === 'accept-steer'
          ? 'Production chosen variant'
          : 'Production manual approved',
      ),
    );
    assert.ok(!source.includes('__IMPECCABLE_LIVE'));
  } else assert.equal(readFileSync(join(appRoot, 'index.html'), 'utf8'), sourceIndex);
  assert.equal(existsSync(join(appRoot, '.impeccable/live/inject-journal.json')), false);
  await assert.rejects(() => remote('/'));
  report.cleanupComplete = true;
  report.checks.revokeCloseAndInjectionRestore = true;
  assert.ok(Object.values(report.checks).every(Boolean));
  report.passed = true;
  report.stage = 'complete';
} catch (error) {
  finishBrowserProfile();
  if (
    (preflightOnly && error?.message === 'ADMISSION_PREFLIGHT_COMPLETE') ||
    (installationOnly && error?.message === 'INSTALLATION_ONLY_COMPLETE') ||
    (constructionOnly && error?.message === 'CONSTRUCTION_ONLY_COMPLETE')
  ) {
    report.passed = true;
    report.stage = preflightOnly
      ? 'admission-preflight-complete'
      : installationOnly
        ? 'installation-only-complete'
        : 'construction-only-complete';
  } else {
    try {
      report.nativeActivity = nativeActivity();
    } catch {
      report.nativeActivity = { unavailable: true };
    }
    generationDirectory ??= readdirSync(controller)
      .filter((name) => name.startsWith('owner-'))
      .map((name) => join(controller, name))[0];
    if (
      generationDirectory &&
      existsSync(
        join(
          controller,
          `inbox-${hash(`${statSync(appRoot).dev}:${statSync(appRoot).ino}`)}.sqlite`,
        ),
      )
    ) {
      const db = new DatabaseSync(
        join(
          controller,
          `inbox-${hash(`${statSync(appRoot).dev}:${statSync(appRoot).ino}`)}.sqlite`,
        ),
        { readOnly: true },
      );
      try {
        report.editInboxAtFailure = {
          events: db
            .prepare('SELECT record FROM live_event_inbox')
            .all()
            .map((row) => {
              const item = JSON.parse(row.record);
              return {
                kind: item.kind,
                stage: item.stage,
                history: item.history,
                idDigest: helperEventIdDigest(item.upstreamId),
              };
            }),
          intents: db.prepare('SELECT phase, code FROM live_poll_intents').all(),
        };
      } finally {
        db.close();
      }
    }
    report.preparationDiagnostics = readdirSync(controller)
      .filter((name) => /^preparation-failure-[a-f0-9-]+\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(controller, name), 'utf8')));
    report.failure = {
      stage: report.stage,
      installationStage: report.installationStage,
      dependency: [
        'owning-runtime-disabled',
        'owning-runtime',
        'event-authority',
        'authenticated-preview',
        'preview-connections',
      ].includes(error?.liveDependency)
        ? error.liveDependency
        : undefined,
      code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '')
        ? error.code
        : [
              'invalid-live-installation-path',
              'live-runtime-not-prepared',
              'live-runtime-symlink',
              'live-runtime-special-file',
              'live-runtime-publish-failed',
            ].includes(error?.message)
          ? error.message.toUpperCase().replaceAll('-', '_')
          : /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? '')
            ? error.message
            : 'UNCLASSIFIED',
    };
    process.exitCode = 1;
  }
} finally {
  report.cleanupStage = 'mobile';
  stopPreviewProbe();
  await probeRefresh;
  if (mobile) {
    try {
      await closeMobileOnce();
      if (report.projectMetadata)
        report.projectMetadata.afterOwnerShutdown = ownedProjectMetadata();
    } catch (error) {
      report.shutdownFailure = 'LIVE_CLEANUP_REQUIRED';
      report.shutdownCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? '')
        ? error.message
        : 'UNCLASSIFIED';
      process.exitCode = 1;
    }
  }
  if (caddy) {
    report.cleanupStage = 'caddy';
    try {
      if (caddy.exitCode === null && caddy.signalCode === null) {
        await new Promise((done, reject) => {
          const deadline = setTimeout(() => reject(new Error('CADDY_CLOSE_DEADLINE')), 10000);
          caddy.once('close', () => {
            clearTimeout(deadline);
            done();
          });
          caddy.kill('SIGTERM');
        });
      }
      caddy = undefined;
    } catch {
      report.shutdownFailure ??= 'CADDY_CLOSE_UNVERIFIED';
      process.exitCode = 1;
    }
  }
  if (provider.listening) {
    report.cleanupStage = 'provider';
    try {
      await new Promise((done, reject) =>
        provider.close((error) => (error ? reject(error) : done())),
      );
    } catch {
      report.shutdownFailure ??= 'PROVIDER_CLOSE_UNVERIFIED';
      process.exitCode = 1;
    }
  }
  if (generationDirectory && existsSync(generationDirectory))
    report.generationEvidence = readdirSync(generationDirectory)
      .filter((name) => /receipt|manifest|bootstrap|owning-configuration/.test(name))
      .map((name) => ({ name, sha256: hash(readFileSync(join(generationDirectory, name))) }));
  if (generationDirectory && existsSync(generationDirectory))
    report.contextProcessDiagnostics = readdirSync(generationDirectory)
      .filter((name) => /^process-[a-f0-9-]{36}\.json$/.test(name))
      .slice(0, 16)
      .map((name) => {
        try {
          const path = join(generationDirectory, name),
            info = lstatSync(path);
          assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024);
          const body = JSON.parse(readFileSync(path, 'utf8')).body;
          // Diagnostic codes only; never copy policy, arguments, environment,
          // native output or private paths. These records do not grant authority.
          const code = (value) =>
            typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : undefined;
          return {
            status: code(body?.status),
            termination: code(body?.termination),
            failure: body?.failure
              ? {
                  phase: code(body.failure.phase),
                  reason: code(body.failure.reason),
                  metadataRole: code(body.failure.metadataRole),
                  code: ['ENOENT', 'EACCES', 'EPERM', 'SPAWN_ERROR'].includes(body.failure.code)
                    ? body.failure.code
                    : undefined,
                }
              : undefined,
          };
        } catch {
          return { unavailable: true };
        }
      });
  if (recoveryHandoff) {
    const state = recoveryHandoff.snapshot();
    report.recoveryHandoff = {
      continuations: state.continuations,
      cancelled: state.cancelled,
      sameDriverBirth: birthCurrent(state.birth),
      phaseTimings: state.phaseTimings,
    };
    if (state.cancelled) {
      report.passed = false;
      report.cleanupComplete = false;
      process.exitCode = 1;
    }
    try {
      await recoveryHandoff.close();
    } catch {
      report.passed = false;
      report.cleanupComplete = false;
      process.exitCode = 1;
    }
  }
  if (!report.shutdownFailure) {
    try {
      removeOwnedProofTree(root, rootIdentity, {
        processesClosed: !mobile && !caddy && !provider.listening,
      });
      report.disposableTreeRemoved = true;
      if (installationOnly || constructionOnly || report.failure?.stage === 'installation')
        report.cleanupComplete = true;
    } catch (error) {
      report.disposableCleanupFailure = [
        'EACCES',
        'EPERM',
        'OWNED_PROOF_PROCESSES_NOT_CLOSED',
        'OWNED_PROOF_IDENTITY_CHANGED',
        'OWNED_PROOF_TREE_UNSAFE',
      ].includes(error?.code ?? error?.message)
        ? (error.code ?? error.message)
        : 'OWNED_PROOF_CLEANUP_FAILED';
      process.exitCode = 1;
    }
  }
  if (report.shutdownFailure || report.disposableCleanupFailure) {
    report.passed = false;
    report.cleanupComplete = false;
  }
  report.cleanupStage = 'settled';
  clearInterval(checkpoint);
  writeFileSync(
    join(evidence, 'production-entrypoint-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      stage: report.stage,
      failure: report.failure,
      checks: report.checks,
      genuine: false,
      cleanupComplete: report.cleanupComplete,
    }) + '\n',
    () => {
      // Failed disposable proofs may intentionally retain a recovery lock.
      // Parent exit ends that owned lifetime; it never claims cleanup passed.
      if (!report.passed) process.exit(1);
    },
  );
}
